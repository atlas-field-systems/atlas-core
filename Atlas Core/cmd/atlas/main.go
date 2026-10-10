package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/hostmanagement"
	"github.com/google/uuid"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run(args []string) error {
	if len(args) == 0 {
		return errors.New("choose prepare, manager-config, setup, status, start, stop, restart, reset, retry, export-ca or enroll")
	}
	if args[0] == "prepare" {
		return prepare(args[1:])
	}
	if args[0] == "manager-config" {
		return managerConfig(args[1:])
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	socket := flags.String("socket", "", "installation manager Unix socket")
	actionID := flags.String("action-id", "", "existing action identity for status/retry; optional new action identity")
	input := flags.String("input", "", "owner-only JSON setup/grant input path")
	output := flags.String("output", "", "export file path")
	noWait := flags.Bool("no-wait", false, "return the accepted action without waiting")
	wait := flags.Duration("wait", 60*time.Second, "finite result wait")
	if err := flags.Parse(args[1:]); err != nil {
		return err
	}
	if *socket == "" {
		return errors.New("installation manager socket is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), *wait)
	defer cancel()
	client := hostmanagement.NewClient(*socket)
	switch args[0] {
	case "status":
		result, err := client.Inspect(ctx, *actionID)
		if err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(result)
	case "export-ca":
		if *output == "" {
			return errors.New("CA export output path is required")
		}
		trust, err := client.ExportCA(ctx)
		if err != nil {
			return err
		}
		if err := retainNewFile(*output, trust.Certificate, 0644); err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(struct {
			Path        string `json:"path"`
			Fingerprint string `json:"fingerprint"`
		}{*output, trust.Fingerprint})
	case "enroll":
		if *output == "" {
			return errors.New("grant output path is required")
		}
		var grant protocol.EnrollmentGrant
		if err := readPrivateJSON(*input, &grant); err != nil {
			return err
		}
		signed, err := client.Enroll(ctx, grant)
		if err != nil {
			return err
		}
		encoded, err := json.Marshal(signed)
		if err != nil {
			return err
		}
		if err := retainNewFile(*output, encoded, 0600); err != nil {
			return err
		}
		return json.NewEncoder(os.Stdout).Encode(struct {
			Path string `json:"path"`
		}{*output})
	case "setup", "start", "stop", "restart", "reset", "retry":
	default:
		return errors.New("unsupported local action")
	}
	if args[0] == "retry" && *actionID == "" {
		return errors.New("retry requires its original action identity")
	}
	if *actionID == "" {
		*actionID = uuid.NewString()
	}
	request := hostmanagement.Request{ActionID: *actionID, Kind: args[0]}
	if request.Kind == "setup" {
		var setup hostmanagement.SetupInput
		if err := readPrivateJSON(*input, &setup); err != nil {
			return err
		}
		request.Setup = &setup
	}
	if request.Kind == "reset" {
		current, err := client.Inspect(ctx, "")
		if err != nil {
			return err
		}
		request.ExpectedResetRevision = &current.ResetRevision
	}
	result, err := client.Submit(ctx, request)
	if err != nil {
		return err
	}
	// Printing the identity before a finite wait lets an interrupted caller
	// recover without converting a retry into another action.
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		return err
	}
	if !*noWait && result.Status == "running" {
		result, err = client.Wait(ctx, result.ActionID)
		if err != nil {
			return err
		}
		if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
			return err
		}
		if result.Status == "incomplete" {
			return result.Failure
		}
	}
	return nil
}
func prepare(args []string) error {
	flags := flag.NewFlagSet("prepare", flag.ContinueOnError)
	dir := flags.String("output-dir", "", "caller-owned retained credential directory")
	names := flags.String("server-names", "127.0.0.1", "comma-separated certificate names/IPs")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *dir == "" {
		return errors.New("caller credential output directory is required")
	}
	if _, err := hostmanagement.PrepareSetup(*dir, strings.Split(*names, ",")); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		KeyPath   string `json:"key_path"`
		SetupPath string `json:"setup_path"`
	}{filepath.Join(*dir, "admin.key"), filepath.Join(*dir, "setup.json")})
}
func managerConfig(args []string) error {
	flags := flag.NewFlagSet("manager-config", flag.ContinueOnError)
	id := flags.String("installation-id", "", "installation UUID")
	root := flags.String("root", "", "owned installation directory")
	recovery := flags.String("recovery-root", "", "external action directory")
	runtime := flags.String("runtime-root", "", "private Unix runtime directory")
	image := flags.String("image", "atlas-core:s1", "locally loaded Core image")
	address := flags.String("bind-address", "127.0.0.1", "local HTTPS bind IP")
	port := flags.Int("port", 8443, "local HTTPS port")
	docker := flags.String("docker", "docker", "Docker executable")
	sudoDocker := flags.Bool("sudo-docker", false, "use sudo -n docker for the host Docker transport")
	output := flags.String("output", "", "owner-only deployment configuration output")
	gid := flags.Int("management-gid", -1, "optional authorized primary local group")
	if err := flags.Parse(args); err != nil {
		return err
	}
	if *id == "" || *output == "" {
		return errors.New("installation identity and output path are required")
	}
	if *root == "" {
		*root = filepath.Join("/var/lib/atlas", *id)
	}
	if *recovery == "" {
		*recovery = filepath.Join("/var/lib/atlas-manager", *id, "actions")
	}
	if *runtime == "" {
		*runtime = filepath.Join("/run/atlas", *id)
	}
	command := hostmanagement.Command{Program: *docker}
	if *sudoDocker {
		command = hostmanagement.Command{Program: "sudo", Prefix: []string{"-n", *docker}}
	}
	options := hostmanagement.Options{InstallationID: *id, Root: *root, RecoveryRoot: *recovery, RuntimeRoot: *runtime, Image: *image, BindAddress: *address, Port: *port, OwnerUID: os.Getuid(), Docker: command}
	if *gid >= 0 {
		options.ManagementGID = gid
	}
	encoded, err := json.MarshalIndent(options, "", "  ")
	if err != nil {
		return err
	}
	if err := retainNewFile(*output, encoded, 0600); err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(struct {
		Path string `json:"path"`
	}{*output})
}
func readPrivateJSON(path string, result any) error {
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm()&0077 != 0 {
		return errors.New("input JSON must be an existing owner-only file")
	}
	file, err := os.Open(path)
	if err != nil {
		return errors.New("input JSON is unavailable")
	}
	defer file.Close()
	decoder := json.NewDecoder(io.LimitReader(file, 65537))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(result); err != nil {
		return errors.New("input JSON is invalid")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return errors.New("input JSON has trailing data")
	}
	return nil
}
func retainNewFile(path string, contents []byte, mode os.FileMode) error {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return fmt.Errorf("retain output file: %w", err)
	}
	_, err = file.Write(contents)
	if err == nil {
		err = file.Sync()
	}
	return errors.Join(err, file.Close())
}
