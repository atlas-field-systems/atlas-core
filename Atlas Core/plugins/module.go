// Package plugins owns durable Operation acceptance and execution bookkeeping.
// Host supervision supplies runtime proof and confirmed loss; it never reads
// these tables or reconstructs Operation transitions.
package plugins

import (
	"bytes"
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strconv"
	"sync"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/plugins/generated/storage"
	"github.com/google/uuid"
	"github.com/santhosh-tekuri/jsonschema/v6"
	_ "modernc.org/sqlite"
)

type Status string

const (
	Pending               Status = "pending"
	InProgress            Status = "in_progress"
	CancellationRequested Status = "cancellation_requested"
	Completed             Status = "completed"
	Failed                Status = "failed"
	Cancelled             Status = "cancelled"
	Interrupted           Status = "interrupted"
)

func terminal(status Status) bool {
	return status == Completed || status == Failed || status == Cancelled || status == Interrupted
}

var (
	ErrUnavailable      = errors.New("plugin_unavailable")
	ErrLimit            = errors.New("resource_limit")
	ErrConflict         = errors.New("submission_conflict")
	ErrAuthority        = errors.New("invalid_authority")
	ErrTerminalConflict = errors.New("terminal_conflict")
	ErrNotFound         = errors.New("not_found")
	ErrDataset          = errors.New("dataset_mismatch")
	ErrUnsupported      = errors.New("unsupported_capability")
	ErrIntegrity        = errors.New("operation_integrity_fault")
)

type Submission struct {
	DatasetID, PluginID, RequestID, CallerID, CapabilityID, InputVersion string
	Input                                                                json.RawMessage
}

const maxSubmissionFieldBytes = 128

func validSubmissionShape(submission Submission) bool {
	// Capability/version support, including empty names, belongs to the
	// installed release lookup rather than this request-shape check.
	return submission.RequestID != "" && submission.PluginID != "" && submission.CallerID != "" &&
		len(submission.RequestID) <= maxSubmissionFieldBytes && len(submission.CallerID) <= maxSubmissionFieldBytes &&
		len(submission.CapabilityID) <= maxSubmissionFieldBytes && len(submission.InputVersion) <= maxSubmissionFieldBytes
}

type Operation struct {
	ID               string
	Original         Submission
	Execution        plugindispatch.Dispatch
	Status           Status
	CancellationID   string
	Progress         json.RawMessage `json:"progress,omitempty"`
	Outcome          *plugindispatch.Outcome
	RecoveredOutcome *plugindispatch.Outcome
	KnownEffects     []plugindispatch.Effect
	KnownOutputs     []plugindispatch.Output
}

type operationRecord struct {
	Operation
	resultSchemaSource
	Exposed        bool
	Acknowledged   bool
	Reports        map[string]string
	LatestSequence uint64
}

// The complete original result context remains part of Core's private record,
// including bundle locations needed to interpret relative references.
type resultSchemaSource struct {
	OutputSchema     json.RawMessage
	ErrorSchema      json.RawMessage            `json:"error_schema,omitempty"`
	SchemaResources  map[string]json.RawMessage `json:"schema_resources,omitempty"`
	OutputSchemaPath string                     `json:"output_schema_path,omitempty"`
	ErrorSchemaPath  string                     `json:"error_schema_path,omitempty"`
}

func resultSource(definition plugindispatch.Capability) resultSchemaSource {
	return resultSchemaSource{definition.OutputSchema, definition.ErrorSchema, definition.SchemaResources, definition.OutputSchemaPath, definition.ErrorSchemaPath}
}

func (source resultSchemaSource) identity() (string, error) {
	// Marshal exactly the owning representation, including resource bytes and
	// paths. Identical root schemas can have different bundle meanings.
	encoded, err := json.Marshal(source)
	return string(encoded), err
}

// RuntimeBinding is a trusted host input. VerifiedProcess must identify the
// host-verified original process, not a PID/container name claimed by a Plugin.
// BindRuntime is replacement-only; VerifyReconnect preserves the old authority.
type RuntimeBinding struct {
	Binding                plugindispatch.Binding
	Token, VerifiedProcess string
	ReceiptCapacity        int
	Release                plugindispatch.Release
	ConfigurationRevision  string
	Capabilities           []plugindispatch.CapabilityIdentity
}

// PluginRelease supplies immutable capability schemas for one installation and
// one exact release. Retained Operations keep their recorded original schemas.
type PluginRelease struct {
	PluginID     string
	Release      plugindispatch.Release
	Capabilities []plugindispatch.Capability
}
type Config struct {
	MaxRuntimeBindings                              int
	DatabasePath, DatasetID, CoreRunID, CoreRelease string
	Contract                                        *plugindispatch.Contract
	Releases                                        []PluginRelease
	MaxOperations                                   int
	ValidateOutput                                  func(context.Context, plugindispatch.Output) error
}
type capability struct {
	definition plugindispatch.Capability
	input      *jsonschema.Schema
}
type capabilityKey struct {
	pluginID         string
	release          plugindispatch.Release
	id, inputVersion string
}
type resultSchemas struct {
	output, failure *jsonschema.Schema
}
type runtime struct {
	drainConfirmed                                    bool
	stagedReceipts                                    map[string]plugindispatch.Dispatch
	host                                              RuntimeBinding
	connected, reconnectVerified, draining, inSession bool
	witness                                           string
	session                                           uint64
	reserved                                          map[string]bool
	cancelSent                                        map[string]string
	cursor                                            int
}
type Module struct {
	issuedBindings map[plugindispatch.Binding]bool
	issuedTokens   map[string]bool
	mu             sync.Mutex
	db             *sql.DB
	queries        *storage.Queries
	cfg            Config
	capabilities   map[capabilityKey]capability
	resultSchemas  map[string]resultSchemas
	runtimes       map[string]*runtime
	closed         bool
	recordsReady   bool
	changed        chan struct{}
}

//go:embed sql/schema.sql
var schema string

const defaultMaxOperations = 100000

func Open(ctx context.Context, cfg Config) (_ *Module, result error) {
	if cfg.Contract == nil || cfg.DatabasePath == "" || cfg.DatasetID == "" || cfg.CoreRunID == "" || cfg.CoreRelease == "" {
		return nil, errors.New("incomplete Plugins configuration")
	}
	if cfg.MaxOperations == 0 {
		cfg.MaxOperations = defaultMaxOperations
	}
	if cfg.MaxRuntimeBindings == 0 {
		cfg.MaxRuntimeBindings = defaultMaxOperations
	}
	if cfg.MaxRuntimeBindings < 1 {
		return nil, ErrLimit
	}
	if cfg.MaxOperations < 1 {
		return nil, ErrLimit
	}
	if len(cfg.Releases) > cfg.MaxRuntimeBindings {
		return nil, ErrLimit
	}
	cfg.Releases = slices.Clone(cfg.Releases)
	for i := range cfg.Releases {
		registration := &cfg.Releases[i]
		if _, err := uuid.Parse(registration.PluginID); err != nil {
			return nil, ErrAuthority
		}
		if len(registration.Capabilities) == 0 || len(registration.Capabilities) > cfg.Contract.Limits.MaxCapabilities {
			return nil, ErrLimit
		}
		identities := make([]plugindispatch.CapabilityIdentity, 0, len(registration.Capabilities))
		for _, definition := range registration.Capabilities {
			identities = append(identities, plugindispatch.CapabilityIdentity{ID: definition.ID, InputVersion: definition.InputVersion})
		}
		declaration := plugindispatch.Ready{Release: registration.Release, ConfigurationRevision: "declaration", ContractVersion: cfg.Contract.Version, Capabilities: identities, ReceiptCapacity: 1, Receipts: []plugindispatch.Receipt{}, LiveWitness: uuid.NewString()}
		binding := plugindispatch.Binding{PluginID: registration.PluginID, PrincipalID: registration.PluginID, DatasetID: cfg.DatasetID, CoreRunID: cfg.CoreRunID, RuntimeGeneration: "declaration"}
		if _, err := cfg.Contract.Encode(plugindispatch.Request{Kind: "ready", Binding: binding, Token: "local-declaration", Ready: &declaration}); err != nil {
			return nil, err
		}
		registration.Capabilities = slices.Clone(registration.Capabilities)
		for j := range registration.Capabilities {
			definition := &registration.Capabilities[j]
			*definition = plugindispatch.CloneCapability(*definition)
		}
	}
	m := &Module{issuedBindings: make(map[plugindispatch.Binding]bool), issuedTokens: make(map[string]bool), cfg: cfg, changed: make(chan struct{}), capabilities: make(map[capabilityKey]capability), resultSchemas: make(map[string]resultSchemas), runtimes: make(map[string]*runtime)}
	for _, registration := range cfg.Releases {
		for _, definition := range registration.Capabilities {
			key := capabilityKey{registration.PluginID, registration.Release, definition.ID, definition.InputVersion}
			if _, exists := m.capabilities[key]; exists {
				return nil, errors.New("duplicate capability")
			}
			input, err := plugindispatch.CompileCapabilitySchema(definition.InputSchema, definition.SchemaResources, definition.InputSchemaPath)
			if err != nil {
				return nil, fmt.Errorf("compile capability input: %w", err)
			}
			if err := m.prepareResultSchemas(resultSource(definition)); err != nil {
				return nil, err
			}
			m.capabilities[key] = capability{definition: definition, input: input}
		}
	}
	db, err := sql.Open("sqlite", "file:"+url.PathEscape(cfg.DatabasePath)+"?_txlock=immediate")
	if err != nil {
		return nil, err
	}
	m.db = db
	m.queries = storage.New(db)
	db.SetMaxOpenConns(1)
	defer func() {
		if result != nil {
			result = errors.Join(result, db.Close())
		}
	}()
	if _, err := db.ExecContext(ctx, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;"+schema); err != nil {
		return nil, fmt.Errorf("initialize Plugins SQLite: %w", err)
	}
	count, err := m.queries.CountOperations(ctx)
	if err != nil {
		return nil, err
	}
	// Construction is the only cache-writing phase. Each entry must belong to
	// a configured capability or a retained Operation; reports cannot add any.
	if err := m.scan(ctx, m.queries, func(operation operationRecord) error {
		if err := m.prepareResultSchemas(operation.resultSchemaSource); err != nil {
			return fmt.Errorf("%w: original result schema: %w", ErrIntegrity, err)
		}
		return m.validateStoredOutcomes(operation)
	}); err != nil {
		return nil, fmt.Errorf("compile retained result schemas: %w", err)
	}
	m.recordsReady = true
	err = m.commit(ctx, func(q *storage.Queries) error {
		metadata, err := q.ReadMetadata(ctx)
		if errors.Is(err, sql.ErrNoRows) {
			if count != 0 {
				return fmt.Errorf("%w: missing retained writing-release marker", ErrIntegrity)
			}
			if err = q.PutMetadata(ctx, storage.PutMetadataParams{DatasetID: cfg.DatasetID, CoreRelease: cfg.CoreRelease}); err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else if metadata.DatasetID != cfg.DatasetID || metadata.CoreRelease != cfg.CoreRelease {
			return errors.New("retained Dataset or writing release mismatch")
		}
		return m.scan(ctx, q, func(operation operationRecord) error {
			if !terminal(operation.Status) {
				operation.Status = Interrupted
				return save(ctx, q, operation)
			}
			return nil
		})
	})
	if err != nil {
		return nil, fmt.Errorf("open retained Plugin Operations: %w", err)
	}
	return m, nil
}

func (m *Module) prepareResultSchemas(source resultSchemaSource) error {
	key, err := source.identity()
	if err != nil {
		return err
	}
	if _, exists := m.resultSchemas[key]; exists {
		return nil
	}
	compiled, err := plugindispatch.CompileCapabilitySchema(source.OutputSchema, source.SchemaResources, source.OutputSchemaPath)
	if err != nil {
		return fmt.Errorf("compile capability output: %w", err)
	}
	prepared := resultSchemas{output: compiled}
	if len(source.ErrorSchema) > 0 {
		prepared.failure, err = plugindispatch.CompileCapabilitySchema(source.ErrorSchema, source.SchemaResources, source.ErrorSchemaPath)
		if err != nil {
			return fmt.Errorf("compile capability error: %w", err)
		}
	}
	m.resultSchemas[key] = prepared
	return nil
}

func (m *Module) Close() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return nil
	}
	m.closed = true
	return m.db.Close()
}
func (m *Module) commit(ctx context.Context, apply func(*storage.Queries) error) (result error) {
	tx, err := m.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if result != nil {
			result = errors.Join(result, tx.Rollback())
		}
	}()
	if err := apply(m.queries.WithTx(tx)); err != nil {
		return err
	}
	return tx.Commit()
}
func save(ctx context.Context, q *storage.Queries, value operationRecord) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return q.UpdateOperation(ctx, storage.UpdateOperationParams{ID: value.ID, Value: string(encoded)})
}
func (m *Module) scan(ctx context.Context, q *storage.Queries, each func(operationRecord) error) error {
	for offset := int64(0); ; offset += 64 {
		rows, err := q.ScanOperations(ctx, storage.ScanOperationsParams{Limit: 64, Offset: offset})
		if err != nil {
			return err
		}
		for _, encoded := range rows {
			value, err := m.decode(encoded)
			if err != nil {
				return err
			}
			if err := each(value); err != nil {
				return err
			}
		}
		if len(rows) < 64 {
			return nil
		}
	}
}
func (m *Module) load(ctx context.Context, q *storage.Queries, id string) (operationRecord, error) {
	encoded, err := q.ReadOperation(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return operationRecord{}, ErrNotFound
	}
	if err != nil {
		return operationRecord{}, err
	}
	return m.decode(encoded)
}

func (m *Module) runtimeWork(ctx context.Context, active *runtime) ([]operationRecord, error) {
	binding := active.host.Binding
	rows, err := m.queries.RuntimeWork(ctx, storage.RuntimeWorkParams{
		DatasetID: binding.DatasetID, PluginID: binding.PluginID, CoreRunID: binding.CoreRunID,
		PrincipalID: binding.PrincipalID, RuntimeGeneration: binding.RuntimeGeneration,
		Capacity: int64(active.host.ReceiptCapacity) + 1,
	})
	if err != nil {
		return nil, err
	}
	if len(rows) > active.host.ReceiptCapacity {
		return nil, fmt.Errorf("%w: unfinished work exceeds receipt capacity", ErrIntegrity)
	}
	work := make([]operationRecord, 0, len(rows))
	for _, row := range rows {
		operation, err := m.decode(row)
		if err != nil {
			return nil, err
		}
		work = append(work, operation)
	}
	return work, nil
}

func (m *Module) Read(ctx context.Context, dataset, plugin, id string) (Operation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if dataset != m.cfg.DatasetID {
		return Operation{}, ErrDataset
	}
	value, err := m.load(ctx, m.queries, id)
	if err != nil {
		return value.Operation, err
	}
	if value.Original.PluginID != plugin {
		return Operation{}, ErrNotFound
	}
	return value.Operation, nil
}
func (m *Module) List(ctx context.Context, dataset, plugin string, limit, offset int) ([]Operation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if dataset != m.cfg.DatasetID {
		return nil, ErrDataset
	}
	if limit < 1 || limit > 100 || offset < 0 {
		return nil, ErrLimit
	}
	encoded, err := m.queries.ListOperations(ctx, storage.ListOperationsParams{DatasetID: dataset, PluginID: plugin, Limit: int64(limit), Offset: int64(offset)})
	if err != nil {
		return nil, err
	}
	result := make([]Operation, 0, len(encoded))
	for _, body := range encoded {
		value, err := m.decode(body)
		if err != nil {
			return nil, err
		}
		result = append(result, value.Operation)
	}
	return result, nil
}
func (m *Module) Submit(ctx context.Context, submission Submission) (operation Operation, result error) {
	var record operationRecord
	m.mu.Lock()
	defer m.mu.Unlock()
	defer m.signal()
	if m.closed {
		return operation, ErrUnavailable
	}
	if submission.DatasetID != m.cfg.DatasetID {
		return operation, ErrDataset
	}
	if len(submission.Input) > m.cfg.Contract.Limits.InputBytes {
		return operation, ErrLimit
	}
	if !validSubmissionShape(submission) {
		return operation, errors.New("invalid_submission")
	}
	input, err := plugindispatch.CanonicalJSON(submission.Input)
	if err != nil {
		return operation, err
	}
	if len(input) > m.cfg.Contract.Limits.InputBytes {
		return operation, ErrLimit
	}
	submission.Input = input
	err = m.commit(ctx, func(q *storage.Queries) error {
		encoded, err := q.ReadSubmission(ctx, storage.ReadSubmissionParams{DatasetID: submission.DatasetID, PluginID: submission.PluginID, RequestID: submission.RequestID})
		if err == nil {
			record, err = m.decode(encoded)
			if err != nil {
				return err
			}
			left, _ := json.Marshal(record.Original)
			right, _ := json.Marshal(submission)
			if !bytes.Equal(left, right) {
				return ErrConflict
			}
			return nil
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		active := m.runtimes[submission.PluginID]
		if active == nil || !active.connected || active.draining {
			return ErrUnavailable
		}
		if len(active.reserved) >= active.host.ReceiptCapacity {
			return ErrLimit
		}
		identity := plugindispatch.CapabilityIdentity{ID: submission.CapabilityID, InputVersion: submission.InputVersion}
		definition, ok := m.capabilities[capabilityKey{submission.PluginID, active.host.Release, identity.ID, identity.InputVersion}]
		if !ok || !slices.Contains(active.host.Capabilities, identity) {
			return ErrUnsupported
		}
		if err := plugindispatch.ValidateJSON(definition.input, input, m.cfg.Contract.Limits.InputBytes); err != nil {
			return err
		}
		count, err := q.CountOperations(ctx)
		if err != nil {
			return err
		}
		if count >= int64(m.cfg.MaxOperations) {
			return ErrLimit
		}
		originalDefinition := plugindispatch.CloneCapability(definition.definition)
		record = operationRecord{Operation: Operation{ID: uuid.NewString(), Original: submission, Status: Pending, Execution: plugindispatch.Dispatch{Binding: active.host.Binding, Release: active.host.Release, CapabilityID: submission.CapabilityID, InputVersion: submission.InputVersion, Input: input, InputDigest: plugindispatch.Digest(input)}}, Reports: make(map[string]string), resultSchemaSource: resultSource(originalDefinition)}
		record.Execution.OperationID = record.ID
		body, err := json.Marshal(record)
		if err != nil {
			return err
		}
		return q.PutOperation(ctx, storage.PutOperationParams{ID: record.ID, DatasetID: submission.DatasetID, PluginID: submission.PluginID, RequestID: submission.RequestID, Value: string(body)})
	})
	if err != nil {
		return Operation{}, err
	}
	if active := m.runtimes[submission.PluginID]; active != nil && !terminal(record.Status) && record.Execution.Binding == active.host.Binding {
		active.reserved[record.ID] = true
	}
	return record.Operation, nil
}
func (m *Module) Cancel(ctx context.Context, dataset, plugin, id string) (operation Operation, result error) {
	var record operationRecord
	m.mu.Lock()
	defer m.mu.Unlock()
	defer m.signal()
	if dataset != m.cfg.DatasetID {
		return operation, ErrDataset
	}
	result = m.commit(ctx, func(q *storage.Queries) error {
		value, err := m.load(ctx, q, id)
		if err != nil {
			return err
		}
		if value.Original.PluginID != plugin {
			return ErrNotFound
		}
		record = value
		if terminal(value.Status) {
			return nil
		}
		if record.CancellationID == "" {
			record.CancellationID = uuid.NewString()
		}
		if record.Exposed {
			record.Status = CancellationRequested
		} else {
			record.Status = Cancelled
			record.Outcome = &plugindispatch.Outcome{Status: string(Cancelled)}
		}
		return save(ctx, q, record)
	})
	if result == nil && record.Status == Cancelled && !record.Exposed {
		if active := m.runtimes[plugin]; active != nil {
			delete(active.reserved, id)
		}
	}
	return record.Operation, result
}
func (m *Module) BindRuntime(ctx context.Context, host RuntimeBinding) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	defer m.signal()
	b := host.Binding
	if b.DatasetID != m.cfg.DatasetID || b.CoreRunID != m.cfg.CoreRunID || b.PluginID == "" || b.PrincipalID == "" || b.RuntimeGeneration == "" || len(host.Token) < 16 || host.VerifiedProcess == "" {
		return ErrAuthority
	}
	if host.ReceiptCapacity < 1 || host.ReceiptCapacity > m.cfg.Contract.Limits.MaxReceipts || len(host.Capabilities) == 0 {
		return ErrLimit
	}
	if previous := m.runtimes[b.PluginID]; previous != nil {
		return errors.New("runtime_already_bound")
	}
	tokenKey := plugindispatch.Digest([]byte(host.Token))
	if m.issuedBindings[b] || m.issuedTokens[tokenKey] {
		return ErrAuthority
	}
	if len(m.issuedBindings) >= m.cfg.MaxRuntimeBindings {
		return ErrLimit
	}
	for _, identity := range host.Capabilities {
		if _, ok := m.capabilities[capabilityKey{b.PluginID, host.Release, identity.ID, identity.InputVersion}]; !ok {
			return ErrUnsupported
		}
	}
	ready := plugindispatch.Ready{Release: host.Release, ConfigurationRevision: host.ConfigurationRevision, ContractVersion: m.cfg.Contract.Version, ReceiptCapacity: host.ReceiptCapacity, Capabilities: host.Capabilities, Receipts: []plugindispatch.Receipt{}, ReceiptsRetained: true, LiveWitness: uuid.NewString()}
	if _, err := m.cfg.Contract.Encode(plugindispatch.Request{Kind: "ready", Binding: b, Token: host.Token, Ready: &ready}); err != nil {
		return err
	}
	host.Capabilities = slices.Clone(host.Capabilities)
	active := &runtime{host: host, reserved: make(map[string]bool), cancelSent: make(map[string]string)}
	err := m.commit(ctx, func(q *storage.Queries) error {
		return m.scan(ctx, q, func(operation operationRecord) error {
			if operation.Original.PluginID != b.PluginID || terminal(operation.Status) || operation.Exposed || operation.Execution.Binding.CoreRunID != m.cfg.CoreRunID {
				return nil
			}
			identity := plugindispatch.CapabilityIdentity{ID: operation.Execution.CapabilityID, InputVersion: operation.Execution.InputVersion}
			if operation.Execution.Release != host.Release || operation.Execution.Binding.PrincipalID != b.PrincipalID || !slices.Contains(host.Capabilities, identity) {
				return errors.New("pending_work_incompatible")
			}
			if len(active.reserved) >= host.ReceiptCapacity {
				return ErrLimit
			}
			active.reserved[operation.ID] = true
			operation.Execution.Binding = b
			return save(ctx, q, operation)
		})
	})
	if err != nil {
		return err
	}
	m.issuedBindings[b] = true
	m.issuedTokens[tokenKey] = true
	m.runtimes[b.PluginID] = active
	return nil
}

// VerifyReconnect is called only after the host verifies the unchanged original
// process. A new live witness or missing acknowledged receipt faults readiness.
func (m *Module) VerifyReconnect(binding plugindispatch.Binding, verifiedProcess string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	active := m.runtimes[binding.PluginID]
	if active == nil || active.host.Binding != binding || active.host.VerifiedProcess != verifiedProcess || active.connected {
		return ErrAuthority
	}
	active.reconnectVerified = true
	return nil
}
func (m *Module) ConfirmLoss(ctx context.Context, binding plugindispatch.Binding) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	defer m.signal()
	active := m.runtimes[binding.PluginID]
	if active == nil || active.host.Binding != binding {
		return ErrAuthority
	}
	if err := m.commit(ctx, func(q *storage.Queries) error {
		return m.scan(ctx, q, func(operation operationRecord) error {
			if operation.Execution.Binding == binding && operation.Exposed && !terminal(operation.Status) {
				operation.Status = Interrupted
				return save(ctx, q, operation)
			}
			return nil
		})
	}); err != nil {
		return err
	}
	delete(m.runtimes, binding.PluginID)
	return nil
}
func (m *Module) Drain(binding plugindispatch.Binding) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	defer m.signal()
	active := m.runtimes[binding.PluginID]
	if active == nil || active.host.Binding != binding {
		return ErrAuthority
	}
	// Retrying the same runtime's drain retains its authenticated confirmation.
	active.draining = true
	return nil
}
func (m *Module) Available(plugin string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	active := m.runtimes[plugin]
	return active != nil && active.connected && !active.draining
}
func parseSequence(value string) (uint64, error) {
	sequence, err := strconv.ParseUint(value, 10, 64)
	if err != nil || sequence == 0 {
		return 0, errors.New("invalid_sequence")
	}
	return sequence, nil
}

func (m *Module) signal()                        { close(m.changed); m.changed = make(chan struct{}) }
func (m *Module) changeChannel() <-chan struct{} { m.mu.Lock(); defer m.mu.Unlock(); return m.changed }

// Drained reports the authenticated finite-work confirmation. Host supervision
// owns the subsequent process action and independently verifies process exit.
func (m *Module) Drained(binding plugindispatch.Binding) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	active := m.runtimes[binding.PluginID]
	if active == nil || active.host.Binding != binding {
		return false, ErrAuthority
	}
	return active.drainConfirmed, nil
}
