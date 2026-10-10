// Package corerun owns one Core run: its private management socket, the
// maintenance state before serving, Dataset opening, public HTTPS serving and
// an orderly stop that joins every writer before closing storage.
package corerun

import (
	"encoding/json"
	"time"

	"github.com/atlas-field-systems/atlas-core/system"
)

// Request is one private management request. One connection carries one
// request and its reply. RunID must name the current Core run, except for
// hello, which discovers it.
type Request struct {
	Action string `json:"action"`
	RunID  string `json:"run_id,omitempty"`

	// setup
	InstallationID      string `json:"installation_id,omitempty"`
	AdminKeyName        string `json:"admin_key_name,omitempty"`
	AdminSecret         string `json:"admin_secret,omitempty"`
	EnrollmentPublicKey string `json:"enrollment_public_key,omitempty"`

	// open
	ResetID string `json:"reset_id,omitempty"`

	// record_activity
	Activity *system.JournalEntry `json:"activity,omitempty"`

	// arm_fault
	Operation string `json:"operation,omitempty"`
	Count     int    `json:"count,omitempty"`
}

// Private management actions.
const (
	ActionHello          = "hello"
	ActionSetup          = "setup"
	ActionInspect        = "inspect"
	ActionOpen           = "open"
	ActionRecordActivity = "record_activity"
	ActionActivity       = "activity"
	ActionArmFault       = "arm_fault"
	ActionStop           = "stop"
)

// States of a Core run.
const (
	StateMaintenance = "maintenance"
	StateServing     = "serving"
	StateStopping    = "stopping"
)

// Establishment is Core's independent proof of the current Dataset.
type Establishment struct {
	SetUp          bool      `json:"set_up"`
	InstallationID string    `json:"installation_id,omitempty"`
	DatasetID      string    `json:"dataset_id,omitempty"`
	ResetID        string    `json:"reset_id,omitempty"`
	WritingRelease string    `json:"writing_release,omitempty"`
	EstablishedAt  time.Time `json:"established_at,omitempty"`
}

// Reply answers one private request.
type Reply struct {
	OK    bool        `json:"ok"`
	Error *ReplyError `json:"error,omitempty"`

	InstallationID string                  `json:"installation_id,omitempty"`
	CoreRelease    string                  `json:"core_release,omitempty"`
	RunID          string                  `json:"run_id,omitempty"`
	State          string                  `json:"state,omitempty"`
	Created        bool                    `json:"created,omitempty"`
	Establishment  *Establishment          `json:"establishment,omitempty"`
	Fresh          bool                    `json:"fresh,omitempty"`
	Imported       int                     `json:"imported,omitempty"`
	Activity       []system.ActivityRecord `json:"activity,omitempty"`
}

// ReplyError is a safe, nonsecret failure description.
type ReplyError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *ReplyError) Error() string { return e.Code + ": " + e.Message }

// MaxMessageBytes bounds one private message.
const MaxMessageBytes = 1 << 20

func failure(code string, err error) Reply {
	return Reply{Error: &ReplyError{Code: code, Message: err.Error()}}
}

// encode is shared by both peers; private messages are single JSON lines.
func encode(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return append(encoded, '\n'), nil
}
