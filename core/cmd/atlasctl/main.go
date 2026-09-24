// Command atlasctl administers a local Atlas installation.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"

	"github.com/atlas-field-systems/atlas-core/core/internal/management"
)

const usage = "usage: atlasctl -root DIR setup|recover|start|stop"

func main() {
	root := flag.String("root", ".", "Atlas installation directory containing compose.yaml and state/")
	flag.Parse()
	if flag.NArg() != 1 {
		fail(usage)
	}
	installation := management.Installation{Root: *root}
	if err := run(context.Background(), installation, flag.Arg(0)); err != nil {
		fail("%s: %v", flag.Arg(0), err)
	}
}

func run(ctx context.Context, installation management.Installation, action string) error {
	switch action {
	case "setup":
		key, err := installation.Setup(ctx)
		if err == nil {
			fmt.Println("Administrative credential:", key)
			fmt.Println("Protected local copy:", installation.FirstKeyFile())
		}
		return err
	case "recover":
		key, err := installation.Recover(ctx)
		if err == nil {
			fmt.Println("Recovery administrative credential:", key)
		}
		return err
	case "start":
		return installation.Start(ctx)
	case "stop":
		return installation.Stop(ctx)
	default:
		return fmt.Errorf("unknown action; %s", usage)
	}
}

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
