package atlas

import (
	"encoding/json"
	"fmt"
	"strings"
)

type FrameContext struct {
	DatasetID     string
	CoreRunID     string
	Authenticated bool
	Subscribed    bool
}

// ValidateFrame checks one complete text message against caller-owned connection state.
func ValidateFrame(direction string, wire []byte, ctx FrameContext, limits Limits) error {
	schema := "ClientFrame"
	if direction == "server" {
		schema = "ServerFrame"
	} else if direction != "client" {
		return fmt.Errorf("invalid frame direction")
	}
	if err := ValidateJSON(schema, wire, limits); err != nil {
		return err
	}
	var frame struct {
		ProtocolVersion string `json:"protocol_version"`
		Response        struct {
			DatasetID string `json:"dataset_id"`
			Error     struct {
				Code string `json:"code"`
			} `json:"error"`
		} `json:"response"`
		Type      string                  `json:"type"`
		DatasetID string                  `json:"dataset_id"`
		CoreRunID string                  `json:"core_run_id"`
		Request   *ReleaseSnapshotRequest `json:"request"`
	}
	if err := json.Unmarshal(wire, &frame); err != nil {
		return err
	}
	if frame.Type == "error" {
		if frame.Response.DatasetID != "" && !strings.EqualFold(frame.Response.DatasetID, frame.DatasetID) {
			return fmt.Errorf("error Dataset mismatch")
		}
		if ctx.DatasetID != "" && !strings.EqualFold(frame.DatasetID, ctx.DatasetID) && frame.Response.Error.Code != "dataset_mismatch" {
			return fmt.Errorf("error Dataset mismatch")
		}
		if frame.ProtocolVersion != Version() && frame.Response.Error.Code != "protocol_mismatch" {
			return fmt.Errorf("error Protocol mismatch")
		}
		return nil
	}
	if frame.Type == "authenticate" {
		if ctx.Authenticated {
			return fmt.Errorf("already authenticated")
		}
	} else if frame.Type != "authenticated" && !ctx.Authenticated {
		return fmt.Errorf("authentication required")
	}
	if ctx.DatasetID != "" && !strings.EqualFold(frame.DatasetID, ctx.DatasetID) {
		return fmt.Errorf("dataset_mismatch")
	}
	if frame.CoreRunID != "" && ctx.CoreRunID != "" && !strings.EqualFold(frame.CoreRunID, ctx.CoreRunID) {
		return fmt.Errorf("Core run mismatch")
	}
	if frame.Type == "changes" || frame.Type == "handoff_complete" || frame.Type == "gap" {
		if !ctx.Subscribed {
			return fmt.Errorf("subscription required")
		}
	}
	if frame.Request != nil && frame.Request.CoreRunId != frame.CoreRunID {
		return fmt.Errorf("release Core run mismatch")
	}
	return nil
}
