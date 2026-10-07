// Package plugindispatch binds the independently versioned private Plugin
// contract. The schema is authored in Protocol and supplied by the release.
package plugindispatch

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/atlas-field-systems/atlas-core/httpcontract"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

type Binding struct {
	PluginID          string `json:"plugin_id"`
	PrincipalID       string `json:"principal_id"`
	DatasetID         string `json:"dataset_id"`
	CoreRunID         string `json:"core_run_id"`
	RuntimeGeneration string `json:"runtime_generation"`
}
type Release struct {
	PackageID   string `json:"package_id"`
	Version     string `json:"version"`
	ImageDigest string `json:"image_digest"`
}
type Capability struct {
	ID, InputVersion                       string
	InputSchema, OutputSchema, ErrorSchema json.RawMessage
}
type Dispatch struct {
	Binding      Binding         `json:"binding"`
	OperationID  string          `json:"operation_id"`
	Release      Release         `json:"release"`
	CapabilityID string          `json:"capability_id"`
	InputVersion string          `json:"input_version"`
	Input        json.RawMessage `json:"input"`
	InputDigest  string          `json:"input_digest"`
}
type Receipt struct {
	Execution Dispatch `json:"execution"`
}
type Effect struct {
	ID          string `json:"id"`
	Description string `json:"description"`
}
type Output struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
}
type Outcome struct {
	Status string          `json:"status"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  json.RawMessage `json:"error,omitempty"`
}
type Evidence struct {
	Execution Dispatch        `json:"execution"`
	Sequence  string          `json:"sequence"`
	Revision  string          `json:"revision"`
	Outcome   *Outcome        `json:"outcome,omitempty"`
	Progress  json.RawMessage `json:"progress,omitempty"`
	Effects   []Effect        `json:"effects,omitempty"`
	Outputs   []Output        `json:"outputs,omitempty"`
}
type Ready struct {
	Release               Release   `json:"release"`
	ConfigurationRevision string    `json:"configuration_revision"`
	ContractVersion       int       `json:"contract_version"`
	CapabilityIDs         []string  `json:"capability_ids"`
	ReceiptsRetained      bool      `json:"receipts_retained"`
	Receipts              []Receipt `json:"receipts"`
	Complete              bool      `json:"complete"`
	LiveWitness           string    `json:"live_witness"`
}
type Cancel struct {
	OperationID    string `json:"operation_id"`
	CancellationID string `json:"cancellation_id"`
}
type Ack struct {
	OperationID string `json:"operation_id"`
	Sequence    string `json:"sequence"`
	Revision    string `json:"revision"`
}
type Request struct {
	Kind     string    `json:"kind"`
	Binding  Binding   `json:"binding"`
	Token    string    `json:"token"`
	Ready    *Ready    `json:"ready,omitempty"`
	Receipt  *Receipt  `json:"receipt,omitempty"`
	Evidence *Evidence `json:"evidence,omitempty"`
}
type Response struct {
	Kind     string    `json:"kind"`
	Dispatch *Dispatch `json:"dispatch,omitempty"`
	Cancel   *Cancel   `json:"cancel,omitempty"`
	Ack      *Ack      `json:"ack,omitempty"`
	Error    string    `json:"error,omitempty"`
}
type Limits struct {
	MaxEffects         int `json:"max_effects"`
	MaxOutputs         int `json:"max_outputs"`
	MessageBytes       int `json:"message_bytes"`
	InputBytes         int `json:"input_bytes"`
	ResultBytes        int `json:"result_bytes"`
	MaxReportRevisions int `json:"max_report_revisions"`
	MaxReceipts        int `json:"max_receipts"`
}
type Contract struct {
	Limits  Limits
	Version int
	schema  *jsonschema.Schema
}

func Load(path string) (*Contract, error) {
	encoded, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read private contract: %w", err)
	}
	if err := httpcontract.CheckJSONDocument(encoded); err != nil {
		return nil, fmt.Errorf("private contract representation: %w", err)
	}
	var metadata struct {
		Version int    `json:"x-dispatch-contract-version"`
		Limits  Limits `json:"x-limits"`
	}
	if err := json.Unmarshal(encoded, &metadata); err != nil {
		return nil, err
	}
	if metadata.Version != 1 || metadata.Limits.MessageBytes <= 0 || metadata.Limits.InputBytes <= 0 || metadata.Limits.ResultBytes <= 0 || metadata.Limits.MaxReportRevisions <= 0 || metadata.Limits.MaxReceipts <= 0 || metadata.Limits.MaxEffects <= 0 || metadata.Limits.MaxOutputs <= 0 {
		return nil, errors.New("unsupported private contract")
	}
	schema, err := CompileSchema(encoded)
	if err != nil {
		return nil, err
	}
	return &Contract{Limits: metadata.Limits, Version: metadata.Version, schema: schema}, nil
}

// CompileSchema accepts self-contained schemas only. No network lookup can
// occur during capability validation or retained-evidence validation.
func CompileSchema(encoded json.RawMessage) (*jsonschema.Schema, error) {
	if err := httpcontract.CheckJSONDocument(encoded); err != nil {
		return nil, err
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	compiler := jsonschema.NewCompiler()
	compiler.UseLoader(jsonschema.SchemeURLLoader{})
	compiler.AssertFormat()
	if err := compiler.AddResource("schema.json", value); err != nil {
		return nil, err
	}
	return compiler.Compile("schema.json")
}
func ValidateJSON(schema *jsonschema.Schema, encoded json.RawMessage, bound int) error {
	if len(encoded) > bound {
		return errors.New("payload_too_large")
	}
	if err := httpcontract.CheckJSONDocument(encoded); err != nil {
		return errors.New("invalid_json")
	}
	value, err := jsonschema.UnmarshalJSON(bytes.NewReader(encoded))
	if err != nil {
		return errors.New("invalid_json")
	}
	if err := schema.Validate(value); err != nil {
		return errors.New("invalid_schema")
	}
	return nil
}
func (c *Contract) Decode(encoded []byte, target any) error {
	if err := ValidateJSON(c.schema, encoded, c.Limits.MessageBytes); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return errors.New("invalid_message")
	}
	return nil
}
func (c *Contract) Encode(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if err := ValidateJSON(c.schema, encoded, c.Limits.MessageBytes); err != nil {
		return nil, err
	}
	return encoded, nil
}
func CanonicalJSON(encoded json.RawMessage) (json.RawMessage, error) {
	if err := httpcontract.CheckJSONDocument(encoded); err != nil {
		return nil, errors.New("invalid_json")
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	return json.Marshal(value)
}
func Digest(encoded []byte) string { sum := sha256.Sum256(encoded); return hex.EncodeToString(sum[:]) }
func Revision(value Evidence) string {
	value.Revision = ""
	encoded, _ := json.Marshal(value)
	return Digest(encoded)
}
func SameDispatch(left, right Dispatch) bool {
	a, _ := json.Marshal(left)
	b, _ := json.Marshal(right)
	return bytes.Equal(a, b)
}

func CloneDispatch(value Dispatch) Dispatch { value.Input = bytes.Clone(value.Input); return value }
func CloneEvidence(value Evidence) Evidence {
	value.Execution = CloneDispatch(value.Execution)
	value.Progress = bytes.Clone(value.Progress)
	value.Effects = append([]Effect(nil), value.Effects...)
	value.Outputs = append([]Output(nil), value.Outputs...)
	if value.Outcome != nil {
		outcome := *value.Outcome
		outcome.Result = bytes.Clone(outcome.Result)
		outcome.Error = bytes.Clone(outcome.Error)
		value.Outcome = &outcome
	}
	return value
}
