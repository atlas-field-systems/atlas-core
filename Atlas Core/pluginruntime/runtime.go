// Package pluginruntime owns one Plugin process's live duplicate receipts and
// durable unacknowledged evidence. A new instance is a new runtime, never a
// reconstruction of the old runtime's execution authority.
package pluginruntime

import (
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/google/uuid"
	"github.com/santhosh-tekuri/jsonschema/v6"
)

var ErrLimit = errors.New("resource_limit")

type Execute func(context.Context, *Invocation) (plugindispatch.Outcome, error)
type Capability struct {
	Definition plugindispatch.Capability
	Execute    Execute
}
type Config struct {
	// AfterEvidenceRename is a deterministic fault-injection boundary. Ordinary
	// use leaves it nil; writes and file sync always precede it.
	AfterEvidenceRename               func() error
	Contract                          *plugindispatch.Contract
	Binding                           plugindispatch.Binding
	Token                             string
	Release                           plugindispatch.Release
	ConfigurationRevision             string
	WorkDirectory                     string
	ReceiptCapacity, MaxEvidenceFiles int
	MaxEvidenceBytes                  int64
	Capabilities                      []Capability
}
type Update struct {
	Progress json.RawMessage
	Effects  []plugindispatch.Effect
	Outputs  []plugindispatch.Output
	Outcome  *plugindispatch.Outcome
}
type receipt struct {
	effects   []plugindispatch.Effect
	outputs   []plugindispatch.Output
	execution plugindispatch.Dispatch
	sequence  uint64
	cancel    context.CancelFunc
	completed bool
}
type compiledCapability struct {
	definition             Capability
	input, output, failure *jsonschema.Schema
}
type capabilityKey struct {
	id, inputVersion string
}
type record struct {
	Format   int                     `json:"format_version"`
	Evidence plugindispatch.Evidence `json:"evidence"`
}
type Runtime struct {
	pending       map[string]plugindispatch.Evidence
	stopped       bool
	storageFault  error
	lifetime      context.Context
	endLifetime   context.CancelFunc
	sessionCancel context.CancelFunc
	sessionDone   chan struct{}
	joined        chan struct{}
	closed        bool
	mu            sync.Mutex
	cfg           Config
	capabilities  map[capabilityKey]compiledCapability
	receipts      map[string]*receipt
	evidence      map[string]plugindispatch.Evidence
	evidenceBytes int64
	pendingCancel map[string]bool
	witness       string
	running       bool
	workers       sync.WaitGroup
	changes       chan struct{}
	failed        chan struct{}
	workerFault   error
	failures      chan error
}

// Invocation provides the original dispatch and durable progress/effect
// reporting. The capability owns external effects; Record cannot make an
// external effect and its evidence one atomic transaction.
type Invocation struct {
	Dispatch plugindispatch.Dispatch
	runtime  *Runtime
}

func (i *Invocation) Record(update Update) (plugindispatch.Evidence, error) {
	return i.runtime.Record(i.Dispatch.OperationID, update)
}

func Open(cfg Config) (*Runtime, error) {
	if cfg.Contract == nil || cfg.WorkDirectory == "" || len(cfg.Token) < 16 || cfg.ReceiptCapacity < 1 || cfg.ReceiptCapacity > cfg.Contract.Limits.MaxReceipts || cfg.MaxEvidenceFiles < 1 || cfg.MaxEvidenceBytes < 1 {
		return nil, errors.New("incomplete Plugin runtime configuration")
	}
	cfg.Capabilities = slices.Clone(cfg.Capabilities)
	for i := range cfg.Capabilities {
		cfg.Capabilities[i].Definition = plugindispatch.CloneCapability(cfg.Capabilities[i].Definition)
	}
	r := &Runtime{cfg: cfg, capabilities: make(map[capabilityKey]compiledCapability), receipts: make(map[string]*receipt), evidence: make(map[string]plugindispatch.Evidence), pending: make(map[string]plugindispatch.Evidence), pendingCancel: make(map[string]bool), witness: uuid.NewString(), changes: make(chan struct{}, 1), failed: make(chan struct{}), failures: make(chan error, 1)}
	r.lifetime, r.endLifetime = context.WithCancel(context.Background())
	for _, capability := range cfg.Capabilities {
		input, err := plugindispatch.CompileCapabilitySchema(capability.Definition.InputSchema, capability.Definition.SchemaResources, capability.Definition.InputSchemaPath)
		if err != nil {
			return nil, err
		}
		output, err := plugindispatch.CompileCapabilitySchema(capability.Definition.OutputSchema, capability.Definition.SchemaResources, capability.Definition.OutputSchemaPath)
		if err != nil {
			return nil, err
		}
		var failure *jsonschema.Schema
		if len(capability.Definition.ErrorSchema) > 0 {
			failure, err = plugindispatch.CompileCapabilitySchema(capability.Definition.ErrorSchema, capability.Definition.SchemaResources, capability.Definition.ErrorSchemaPath)
			if err != nil {
				return nil, err
			}
		}
		if capability.Execute == nil {
			return nil, errors.New("capability execution missing")
		}
		key := capabilityKey{capability.Definition.ID, capability.Definition.InputVersion}
		if _, exists := r.capabilities[key]; exists {
			return nil, errors.New("duplicate capability")
		}
		r.capabilities[key] = compiledCapability{definition: capability, input: input, output: output, failure: failure}
	}
	if err := os.MkdirAll(cfg.WorkDirectory, 0o700); err != nil {
		return nil, err
	}
	directory, err := os.Open(cfg.WorkDirectory)
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	for {
		entries, err := directory.ReadDir(64)
		if err != nil && !errors.Is(err, io.EOF) {
			return nil, err
		}
		for _, entry := range entries {
			// Interrupted atomic replacement leaves only an uncommitted temporary
			// candidate. Retained committed records are always *.evidence.json.
			if strings.HasPrefix(entry.Name(), ".evidence-") {
				if err := os.Remove(filepath.Join(cfg.WorkDirectory, entry.Name())); err != nil {
					return nil, err
				}
				continue
			}
			if !strings.HasSuffix(entry.Name(), ".evidence.json") {
				return nil, errors.New("incompatible_retained_evidence")
			}
			info, err := entry.Info()
			if err != nil {
				return nil, err
			}
			if !info.Mode().IsRegular() {
				return nil, errors.New("incompatible_retained_evidence")
			}
			if info.Size() > int64(cfg.Contract.Limits.MessageBytes) || info.Size()+r.evidenceBytes > cfg.MaxEvidenceBytes || len(r.evidence) >= cfg.MaxEvidenceFiles {
				return nil, ErrLimit
			}
			encoded, err := os.ReadFile(filepath.Join(cfg.WorkDirectory, entry.Name()))
			if err != nil {
				return nil, err
			}
			var retained record
			if err := cfg.Contract.Decode(encoded, &retained); err != nil {
				return nil, errors.New("corrupt_retained_evidence")
			}
			evidence := retained.Evidence
			b := evidence.Execution.Binding
			if evidence.Outcome == nil && len(evidence.Effects) == 0 && len(evidence.Outputs) == 0 {
				return nil, errors.New("incompatible_retained_evidence")
			}
			if retained.Format != cfg.Contract.Version || evidence.Revision != plugindispatch.Revision(evidence) || b.PluginID != cfg.Binding.PluginID || b.PrincipalID != cfg.Binding.PrincipalID || b.DatasetID != cfg.Binding.DatasetID || entry.Name() != evidence.Execution.OperationID+".evidence.json" {
				return nil, errors.New("incompatible_retained_evidence")
			}
			if _, exists := r.evidence[evidence.Execution.OperationID]; exists {
				return nil, errors.New("duplicate_retained_evidence")
			}
			r.evidence[evidence.Execution.OperationID] = evidence
			r.evidenceBytes += int64(len(encoded))
		}
		if errors.Is(err, io.EOF) {
			break
		}
	}
	return r, nil
}
func (r *Runtime) notify() {
	select {
	case r.changes <- struct{}{}:
	default:
	}
}
func (r *Runtime) Ready(complete bool) plugindispatch.Ready {
	r.mu.Lock()
	defer r.mu.Unlock()
	capabilities := make([]plugindispatch.CapabilityIdentity, 0, len(r.capabilities))
	for key := range r.capabilities {
		capabilities = append(capabilities, plugindispatch.CapabilityIdentity{ID: key.id, InputVersion: key.inputVersion})
	}
	slices.SortFunc(capabilities, func(a, b plugindispatch.CapabilityIdentity) int {
		if order := cmp.Compare(a.ID, b.ID); order != 0 {
			return order
		}
		return cmp.Compare(a.InputVersion, b.InputVersion)
	})
	receipts := make([]plugindispatch.Receipt, 0, len(r.receipts))
	for _, receipt := range r.receipts {
		receipts = append(receipts, plugindispatch.Receipt{Execution: plugindispatch.CloneDispatch(receipt.execution)})
	}
	sort.Slice(receipts, func(i, j int) bool { return receipts[i].Execution.OperationID < receipts[j].Execution.OperationID })
	return plugindispatch.Ready{Release: r.cfg.Release, ConfigurationRevision: r.cfg.ConfigurationRevision, ContractVersion: r.cfg.Contract.Version, Capabilities: capabilities, ReceiptCapacity: r.cfg.ReceiptCapacity, ReceiptsRetained: true, Receipts: receipts, Complete: complete, LiveWitness: r.witness}
}
func (r *Runtime) Retained() []plugindispatch.Evidence {
	r.mu.Lock()
	defer r.mu.Unlock()
	result := make([]plugindispatch.Evidence, 0, len(r.evidence))
	for _, evidence := range r.evidence {
		result = append(result, plugindispatch.CloneEvidence(evidence))
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Execution.OperationID < result[j].Execution.OperationID })
	return result
}

// Accept inserts a live receipt before starting capability code. ACK and durable
// cleanup never delete it. Callers can exercise the same boundary for delayed
// dispatch delivery without a second execution path.
func (r *Runtime) Accept(ctx context.Context, dispatch plugindispatch.Dispatch) (bool, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return false, errors.New("runtime_closed")
	}
	if r.workerFault != nil {
		return false, r.workerFault
	}
	if r.storageFault != nil {
		return false, r.storageFault
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	if len(dispatch.Input) > r.cfg.Contract.Limits.InputBytes {
		return false, ErrLimit
	}
	dispatch = plugindispatch.CloneDispatch(dispatch)
	if dispatch.Binding != r.cfg.Binding || dispatch.Release != r.cfg.Release {
		return false, errors.New("invalid_authority")
	}
	if dispatch.InputDigest != plugindispatch.Digest(dispatch.Input) {
		return false, errors.New("input_digest_mismatch")
	}
	if previous := r.receipts[dispatch.OperationID]; previous != nil {
		if !plugindispatch.SameDispatch(previous.execution, dispatch) {
			return false, errors.New("dispatch_conflict")
		}
		return true, nil
	}
	if len(r.receipts) >= r.cfg.ReceiptCapacity {
		return false, ErrLimit
	}
	capability, exists := r.capabilities[capabilityKey{dispatch.CapabilityID, dispatch.InputVersion}]
	if !exists {
		return false, errors.New("unsupported_capability")
	}
	if err := plugindispatch.ValidateJSON(capability.input, dispatch.Input, r.cfg.Contract.Limits.InputBytes); err != nil {
		return false, err
	}
	work, cancel := context.WithCancel(r.lifetime)
	retained := &receipt{execution: dispatch, cancel: cancel}
	r.receipts[dispatch.OperationID] = retained
	if r.pendingCancel[dispatch.OperationID] {
		cancel()
		delete(r.pendingCancel, dispatch.OperationID)
	}
	r.workers.Add(1)
	go func() {
		defer r.workers.Done()
		defer cancel()
		outcome, err := capability.definition.Execute(work, &Invocation{Dispatch: plugindispatch.CloneDispatch(dispatch), runtime: r})
		if err == nil {
			_, err = r.Record(dispatch.OperationID, Update{Outcome: &outcome})
		}
		if err != nil {
			r.fail(fmt.Errorf("capability execution/evidence failed: %w", err))
		}
	}()
	return false, nil
}

func (r *Runtime) fail(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.workerFault != nil {
		return
	}
	// Keep control failure independent of the bounded observer notification.
	// Observing it cannot restore readiness or forget an unfinished receipt.
	r.workerFault = err
	close(r.failed)
	select {
	case r.failures <- err:
	default:
	}
}
func (r *Runtime) Cancel(cancel plugindispatch.Cancel) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if receipt := r.receipts[cancel.OperationID]; receipt != nil {
		receipt.cancel()
		return nil
	}
	if len(r.pendingCancel) >= r.cfg.ReceiptCapacity {
		return ErrLimit
	}
	r.pendingCancel[cancel.OperationID] = true
	return nil
}
func (r *Runtime) Record(id string, update Update) (plugindispatch.Evidence, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.stopped {
		return plugindispatch.Evidence{}, errors.New("runtime_closed")
	}
	if r.storageFault != nil {
		return plugindispatch.Evidence{}, r.storageFault
	}
	if len(update.Progress) > r.cfg.Contract.Limits.MessageBytes || len(update.Effects) > r.cfg.Contract.Limits.MaxEffects || len(update.Outputs) > r.cfg.Contract.Limits.MaxOutputs {
		return plugindispatch.Evidence{}, ErrLimit
	}
	if update.Outcome != nil && (len(update.Outcome.Result) > r.cfg.Contract.Limits.ResultBytes || len(update.Outcome.Error) > r.cfg.Contract.Limits.ResultBytes) {
		return plugindispatch.Evidence{}, ErrLimit
	}
	receipt := r.receipts[id]
	if receipt == nil {
		return plugindispatch.Evidence{}, errors.New("unknown_receipt")
	}
	if receipt.completed {
		return plugindispatch.Evidence{}, errors.New("terminal_conflict")
	}
	limit := r.cfg.Contract.Limits.MaxReportRevisions
	if update.Outcome == nil {
		limit-- // Keep a revision available for the final outcome.
	}
	if receipt.sequence >= uint64(limit) {
		return plugindispatch.Evidence{}, ErrLimit
	}
	evidence := plugindispatch.CloneEvidence(plugindispatch.Evidence{Execution: plugindispatch.CloneDispatch(receipt.execution), Sequence: strconv.FormatUint(receipt.sequence+1, 10), Outcome: update.Outcome, Progress: update.Progress, Effects: update.Effects, Outputs: update.Outputs})
	// Validate the whole proposed effect set before saving it or changing the
	// receipt. Repeating one identity is harmless only with identical facts.
	proposedEffects := slices.Concat(evidence.Effects, receipt.effects)
	evidence.Effects = nil
	for _, effect := range proposedEffects {
		found := false
		for _, known := range evidence.Effects {
			if known.ID == effect.ID {
				if known != effect {
					return evidence, errors.New("effect_conflict")
				}
				found = true
			}
		}
		if !found {
			if len(evidence.Effects) >= r.cfg.Contract.Limits.MaxEffects {
				return evidence, ErrLimit
			}
			evidence.Effects = append(evidence.Effects, effect)
		}
	}
	if len(receipt.outputs) > 0 {
		for _, output := range receipt.outputs {
			found := false
			for _, next := range evidence.Outputs {
				if next == output {
					found = true
				}
			}
			if !found {
				evidence.Outputs = append(evidence.Outputs, output)
			}
		}
	}
	if update.Outcome != nil {
		capability := r.capabilities[capabilityKey{receipt.execution.CapabilityID, receipt.execution.InputVersion}]
		if err := plugindispatch.ValidateOutcome(*update.Outcome, capability.output, capability.failure, r.cfg.Contract.Limits.ResultBytes); err != nil {
			return evidence, err
		}
	}
	evidence.Revision = plugindispatch.Revision(evidence)
	durable := evidence.Outcome != nil || len(evidence.Effects) > 0 || len(evidence.Outputs) > 0
	encoded, err := r.cfg.Contract.Encode(record{Format: r.cfg.Contract.Version, Evidence: evidence})
	if err != nil {
		return evidence, err
	}
	if durable {
		oldBytes := int64(0)
		if old, found := r.evidence[id]; found {
			body, err := r.cfg.Contract.Encode(record{Format: r.cfg.Contract.Version, Evidence: old})
			if err != nil {
				return evidence, err
			}
			oldBytes = int64(len(body))
		} else if len(r.evidence) >= r.cfg.MaxEvidenceFiles {
			return evidence, ErrLimit
		}
		// Count the temporary replacement too, so atomicity does not hide an
		// unaccounted disk peak. Quota refusal leaves the old evidence intact.
		if r.evidenceBytes+int64(len(encoded)) > r.cfg.MaxEvidenceBytes {
			return evidence, ErrLimit
		}
		if err := r.persist(id, encoded); err != nil {
			r.storageFault = fmt.Errorf("evidence_storage_fault: %w", err)
			return evidence, r.storageFault
		}
		r.evidence[id] = evidence
		r.evidenceBytes += int64(len(encoded)) - oldBytes
	}
	r.pending[id] = evidence
	receipt.effects = append([]plugindispatch.Effect(nil), evidence.Effects...)
	receipt.outputs = append([]plugindispatch.Output(nil), evidence.Outputs...)
	receipt.sequence++
	receipt.completed = update.Outcome != nil
	r.notify()
	return plugindispatch.CloneEvidence(evidence), nil
}
func (r *Runtime) persist(id string, encoded []byte) (result error) {
	temporary, err := os.CreateTemp(r.cfg.WorkDirectory, ".evidence-")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer func() {
		if err := os.Remove(name); err != nil && !errors.Is(err, os.ErrNotExist) {
			result = errors.Join(result, err)
		}
	}()
	if _, err := temporary.Write(encoded); err != nil {
		return errors.Join(err, temporary.Close())
	}
	if err := temporary.Sync(); err != nil {
		return errors.Join(err, temporary.Close())
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, filepath.Join(r.cfg.WorkDirectory, id+".evidence.json")); err != nil {
		return err
	}
	if r.cfg.AfterEvidenceRename != nil {
		if err := r.cfg.AfterEvidenceRename(); err != nil {
			return err
		}
	}
	return r.syncDirectory()
}
func (r *Runtime) syncDirectory() (result error) {
	directory, err := os.Open(r.cfg.WorkDirectory)
	if err != nil {
		return err
	}
	defer func() { result = errors.Join(result, directory.Close()) }()
	return directory.Sync()
}

// Acknowledge removes only the exact synced revision. It shares Record's lock,
// so a delayed ACK cannot unlink a newer atomic replacement.
func (r *Runtime) Acknowledge(ack plugindispatch.Ack) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.storageFault != nil {
		return r.storageFault
	}
	if pending, found := r.pending[ack.OperationID]; found && pending.Sequence == ack.Sequence && pending.Revision == ack.Revision {
		delete(r.pending, ack.OperationID)
	}
	evidence, found := r.evidence[ack.OperationID]
	if !found {
		return nil
	}
	if evidence.Sequence != ack.Sequence || evidence.Revision != ack.Revision {
		return nil
	}
	encoded, err := r.cfg.Contract.Encode(record{Format: r.cfg.Contract.Version, Evidence: evidence})
	if err != nil {
		return err
	}
	if err := os.Remove(filepath.Join(r.cfg.WorkDirectory, ack.OperationID+".evidence.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := r.syncDirectory(); err != nil {
		r.storageFault = fmt.Errorf("evidence_storage_fault: %w", err)
		return r.storageFault
	}
	delete(r.evidence, ack.OperationID)
	r.evidenceBytes -= int64(len(encoded))
	return nil
}

// Close ends the runtime and refuses new sessions/receipts before joining work.
// A timeout reports incomplete shutdown; the owner must retain storage and use
// its process boundary rather than claiming writers have stopped.
func (r *Runtime) Close(ctx context.Context) error {
	r.mu.Lock()
	if !r.closed {
		r.closed = true
		r.endLifetime()
		if r.sessionCancel != nil {
			r.sessionCancel()
		}
		session := r.sessionDone
		r.joined = make(chan struct{})
		go func() {
			if session != nil {
				<-session
			}
			r.workers.Wait()
			r.mu.Lock()
			r.stopped = true
			r.mu.Unlock()
			close(r.joined)
		}()
	}
	joined := r.joined
	r.mu.Unlock()
	select {
	case <-joined:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Faults reports the first fatal worker failure without consuming Run's control
// signal. The owner still uses Close to cancel and join surviving workers.
func (r *Runtime) Faults() <-chan error { return r.failures }
func (r *Runtime) finiteFinished() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, receipt := range r.receipts {
		if !receipt.completed {
			return false
		}
	}
	return len(r.evidence) == 0 && len(r.pending) == 0
}

// ReadyPages sends the full live inventory in bounded frames. Complete appears
// only in the final empty page, after every receipt and retained evidence can
// be validated. Receipts remain in memory throughout this exchange.
func (r *Runtime) ReadyPages() ([]plugindispatch.Ready, error) {
	ready := r.Ready(false)
	receipts := ready.Receipts
	ready.Receipts = []plugindispatch.Receipt{}
	pages := []plugindispatch.Ready{ready}
	for _, receipt := range receipts {
		candidate := pages[len(pages)-1]
		candidate.Receipts = append(candidate.Receipts, receipt)
		_, err := r.cfg.Contract.Encode(plugindispatch.Request{Kind: "ready", Binding: r.cfg.Binding, Token: r.cfg.Token, Ready: &candidate})
		if err != nil {
			empty := ready
			empty.Receipts = []plugindispatch.Receipt{receipt}
			if _, err := r.cfg.Contract.Encode(plugindispatch.Request{Kind: "ready", Binding: r.cfg.Binding, Token: r.cfg.Token, Ready: &empty}); err != nil {
				return nil, err
			}
			pages = append(pages, empty)
		} else {
			pages[len(pages)-1] = candidate
		}
	}
	final := ready
	final.Complete = true
	pages = append(pages, final)
	return pages, nil
}

// Pending includes the latest bounded live report for each receipt. Ordinary
// progress is queued only here, while Retained exposes only synced evidence.
func (r *Runtime) Pending() []plugindispatch.Evidence {
	r.mu.Lock()
	defer r.mu.Unlock()
	values := make(map[string]plugindispatch.Evidence, len(r.pending)+len(r.evidence))
	for id, evidence := range r.evidence {
		values[id] = evidence
	}
	for id, evidence := range r.pending {
		values[id] = evidence
	}
	result := make([]plugindispatch.Evidence, 0, len(values))
	for _, evidence := range values {
		result = append(result, plugindispatch.CloneEvidence(evidence))
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Execution.OperationID < result[j].Execution.OperationID })
	return result
}
