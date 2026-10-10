package systemoperations

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/atlas-field-systems/atlas-core/coremaintenance"
	"github.com/atlas-field-systems/atlas-core/httpcontract"
	"github.com/atlas-field-systems/atlas-core/writecommit"
	"github.com/google/uuid"
	"os"
	"time"
)

func (c *Core) recordLocal(ctx context.Context, commit *writecommit.Commit, request coremaintenance.Request) error {
	activity := request.Activity
	if activity == nil {
		kind := request.Kind
		if kind == "open" {
			kind = "start"
		}
		activity = &coremaintenance.LocalAction{ActionID: request.ActionID, Kind: kind, ActorUID: uint32(os.Getuid()), ActorGID: uint32(os.Getgid()), AcceptedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	}
	if activity.ActionID != request.ActionID {
		return errors.New("local action identity mismatch")
	}
	return c.importAction(ctx, commit, *activity)
}
func (c *Core) importAction(ctx context.Context, commit *writecommit.Commit, action coremaintenance.LocalAction) error {
	if _, err := uuid.Parse(action.ActionID); err != nil {
		return err
	}
	if _, err := time.Parse(time.RFC3339Nano, action.AcceptedAt); err != nil {
		return err
	}
	switch action.Kind {
	case "setup", "start", "stop", "restart", "reset":
	default:
		return errors.New("unknown local activity")
	}
	return c.boundary.RecordLocal(ctx, commit, action.ActionID, fmt.Sprintf("unix:%d:%d", action.ActorUID, action.ActorGID), action.Kind, action.AcceptedAt)
}

// ImportActivity records each retained local action once. Host Reset clears its
// journal before fresh establishment; replay markers share the Dataset lifetime.
func (c *Core) ImportActivity(ctx context.Context, path string) error {
	if path == "" {
		return nil
	}
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 4096), 65536)
	actions := []coremaintenance.LocalAction{}
	for scanner.Scan() {
		body := scanner.Bytes()
		if err = httpcontract.CheckJSONDocument(body); err != nil {
			return err
		}
		var action coremaintenance.LocalAction
		if err = json.Unmarshal(body, &action); err != nil {
			return err
		}
		actions = append(actions, action)
		if len(actions) > 100000 {
			return errors.New("local activity journal exceeds its bound")
		}
	}
	if err = scanner.Err(); err != nil {
		return err
	}
	_, err = c.boundary.Apply(ctx, "", func(commit *writecommit.Commit) error {
		if commit.Metadata.DatasetID == "" {
			return errors.New("setup_required")
		}
		for _, action := range actions {
			if err := c.importAction(ctx, commit, action); err != nil {
				return err
			}
		}
		return nil
	})
	return err
}
