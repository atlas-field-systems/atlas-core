package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/atlas-field-systems/atlas-core/hostmanagement"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	config := flag.String("config", "", "owner-only manager deployment configuration")
	flag.Parse()
	if *config == "" {
		return fmt.Errorf("manager configuration path is required")
	}
	info, err := os.Stat(*config)
	if err != nil {
		return fmt.Errorf("manager configuration is unavailable")
	}
	if info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("manager configuration must be owner-only")
	}
	file, err := os.Open(*config)
	if err != nil {
		return fmt.Errorf("manager configuration is unavailable")
	}
	defer file.Close()
	var options hostmanagement.Options
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&options); err != nil {
		return fmt.Errorf("manager configuration is invalid")
	}
	manager, err := hostmanagement.New(options)
	if err != nil {
		return err
	}
	defer manager.Close()
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	return manager.Serve(ctx)
}
