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
	"io/fs"
	"net/url"
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
	ID, InputVersion          string
	InputSchema, OutputSchema json.RawMessage
	ErrorSchema               json.RawMessage `json:"error_schema,omitempty"`
	SchemaResources           map[string]json.RawMessage
	InputSchemaPath           string `json:"input_schema_path,omitempty"`
	OutputSchemaPath          string `json:"output_schema_path,omitempty"`
	ErrorSchemaPath           string `json:"error_schema_path,omitempty"`
}
type CapabilityIdentity struct {
	ID           string `json:"capability_id"`
	InputVersion string `json:"input_version"`
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
	Release               Release              `json:"release"`
	ConfigurationRevision string               `json:"configuration_revision"`
	ContractVersion       int                  `json:"contract_version"`
	Capabilities          []CapabilityIdentity `json:"capabilities"`
	ReceiptsRetained      bool                 `json:"receipts_retained"`
	ReceiptCapacity       int                  `json:"receipt_capacity"`
	Receipts              []Receipt            `json:"receipts"`
	Complete              bool                 `json:"complete"`
	LiveWitness           string               `json:"live_witness"`
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
	MaxEffects         int `json:"-"`
	MaxOutputs         int `json:"-"`
	MaxCapabilities    int `json:"-"`
	MessageBytes       int `json:"message_bytes"`
	InputBytes         int `json:"input_bytes"`
	ResultBytes        int `json:"result_bytes"`
	MaxReportRevisions int `json:"max_report_revisions"`
	MaxReceipts        int `json:"-"`
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
	if metadata.Version != 1 || metadata.Limits.MessageBytes <= 0 || metadata.Limits.InputBytes <= 0 || metadata.Limits.ResultBytes <= 0 || metadata.Limits.MaxReportRevisions <= 0 {
		return nil, errors.New("unsupported private contract")
	}
	schema, err := CompileSchema(encoded)
	if err != nil {
		return nil, err
	}
	// These quotas are the same authored facts that validate private frames.
	// Read the compiled schema rather than maintain another limit declaration.
	if len(schema.OneOf) == 0 || schema.OneOf[0].Ref == nil {
		return nil, errors.New("unsupported private contract")
	}
	request := schema.OneOf[0].Ref
	for _, bound := range []struct {
		message, property string
		target            *int
	}{{"evidence", "effects", &metadata.Limits.MaxEffects}, {"evidence", "outputs", &metadata.Limits.MaxOutputs}, {"ready", "receipts", &metadata.Limits.MaxReceipts}, {"ready", "capabilities", &metadata.Limits.MaxCapabilities}} {
		message := request.Properties[bound.message]
		if message == nil || message.Ref == nil {
			return nil, errors.New("unsupported private contract")
		}
		array := message.Ref.Properties[bound.property]
		if array == nil || array.MaxItems == nil || *array.MaxItems < 1 {
			return nil, errors.New("unsupported private contract")
		}
		*bound.target = *array.MaxItems
	}
	return &Contract{Limits: metadata.Limits, Version: metadata.Version, schema: schema}, nil
}

// ValidateOutcome checks the terminal payload against the original capability
// schemas. Core still owns the Operation transition and output resolution.
func ValidateOutcome(outcome Outcome, output, failure *jsonschema.Schema, bound int) error {
	switch outcome.Status {
	case "completed":
		if len(outcome.Result) == 0 || len(outcome.Error) != 0 || output == nil {
			return errors.New("invalid_outcome")
		}
		return ValidateJSON(output, outcome.Result, bound)
	case "failed":
		if len(outcome.Error) == 0 || len(outcome.Result) != 0 {
			return errors.New("invalid_outcome")
		}
		return ValidateJSON(failure, outcome.Error, bound)
	case "cancelled":
		if len(outcome.Result) != 0 || len(outcome.Error) != 0 {
			return errors.New("invalid_outcome")
		}
		return nil
	default:
		return errors.New("invalid_outcome")
	}
}

// CompileSchema compiles a self-contained schema without external retrieval.
func CompileSchema(encoded json.RawMessage) (*jsonschema.Schema, error) {
	return CompileCapabilitySchema(encoded, nil, "")
}

const schemaRootURL = "https://atlas.invalid/plugin-schema/"

// CompileCapabilitySchema compiles a root schema with its local bundle files.
// No filesystem or network loader is enabled, including for missing references.
func CompileCapabilitySchema(encoded json.RawMessage, resources map[string]json.RawMessage, location string) (*jsonschema.Schema, error) {
	rootURL := schemaRootURL
	if location != "" {
		var err error
		rootURL, err = localSchemaURL(location)
		if err != nil {
			return nil, err
		}
	}
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
	if err := compiler.AddResource(rootURL, value); err != nil {
		return nil, err
	}
	for name, encoded := range resources {
		resourceURL, err := localSchemaURL(name)
		if err != nil {
			return nil, err
		}
		if err := httpcontract.CheckJSONDocument(encoded); err != nil {
			return nil, fmt.Errorf("invalid local schema resource: %w", err)
		}
		resource, err := jsonschema.UnmarshalJSON(bytes.NewReader(encoded))
		if err != nil {
			return nil, err
		}
		if resourceURL == rootURL {
			rootBytes, err := json.Marshal(value)
			if err != nil {
				return nil, err
			}
			resourceBytes, err := json.Marshal(resource)
			if err != nil {
				return nil, err
			}
			if !bytes.Equal(rootBytes, resourceBytes) {
				return nil, errors.New("conflicting local root schema")
			}
			continue
		}
		if err := compiler.AddResource(resourceURL, resource); err != nil {
			return nil, err
		}
	}
	return compiler.Compile(rootURL)
}

func localSchemaURL(name string) (string, error) {
	location, err := url.Parse(name)
	if err != nil || !fs.ValidPath(name) || name == "." || location.Scheme != "" || location.Host != "" || location.RawQuery != "" || location.Fragment != "" || location.Path != name {
		return "", errors.New("invalid local schema resource name")
	}
	return schemaRootURL + location.EscapedPath(), nil
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
	// The private outcome contract permits arbitrary JSON errors when a
	// capability declares no additional error schema.
	if schema != nil {
		if err := schema.Validate(value); err != nil {
			return errors.New("invalid_schema")
		}
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
func CloneCapability(value Capability) Capability {
	value.InputSchema = bytes.Clone(value.InputSchema)
	value.OutputSchema = bytes.Clone(value.OutputSchema)
	value.ErrorSchema = bytes.Clone(value.ErrorSchema)
	if value.SchemaResources != nil {
		resources := make(map[string]json.RawMessage, len(value.SchemaResources))
		for name, schema := range value.SchemaResources {
			resources[name] = bytes.Clone(schema)
		}
		value.SchemaResources = resources
	}
	return value
}
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
