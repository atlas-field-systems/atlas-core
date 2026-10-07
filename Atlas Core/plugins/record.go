package plugins

import (
	"bytes"
	"encoding/json"
	"fmt"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/plugins/generated/storage"
)

func (m *Module) decode(row storage.PluginOperation) (operationRecord, error) {
	var operation operationRecord
	fault := func(reason string) (operationRecord, error) {
		return operationRecord{}, fmt.Errorf("%w: %s", ErrIntegrity, reason)
	}
	canonical, err := plugindispatch.CanonicalJSON(json.RawMessage(row.Value))
	if err != nil {
		return fault("invalid stored JSON representation")
	}
	decoder := json.NewDecoder(bytes.NewBufferString(row.Value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&operation); err != nil {
		return fault("invalid stored record shape")
	}
	encoded, err := json.Marshal(operation)
	if err != nil {
		return fault("invalid stored record values")
	}
	normalized, err := plugindispatch.CanonicalJSON(encoded)
	// Derive exact keys and required presence from the owning representation.
	// This also rejects Go's case-insensitive aliases, which SQLite's JSON
	// expressions would otherwise interpret differently. Opaque JSON stays opaque.
	if err != nil || !bytes.Equal(canonical, normalized) {
		return fault("missing, null or mis-cased stored fields")
	}
	if row.ID != operation.ID || row.DatasetID != operation.Original.DatasetID || row.PluginID != operation.Original.PluginID || row.RequestID != operation.Original.RequestID || row.DatasetID != m.cfg.DatasetID {
		return fault("stored lookup identity mismatch")
	}
	original, execution := operation.Original, operation.Execution
	if !validSubmissionShape(original) {
		return fault("invalid original submission shape")
	}
	if operation.ID != execution.OperationID || original.DatasetID != execution.Binding.DatasetID || original.PluginID != execution.Binding.PluginID || original.CapabilityID != execution.CapabilityID || original.InputVersion != execution.InputVersion {
		return fault("original execution identity mismatch")
	}
	input, err := plugindispatch.CanonicalJSON(execution.Input)
	if err != nil || len(input) > m.cfg.Contract.Limits.InputBytes || plugindispatch.Digest(input) != execution.InputDigest {
		return fault("original input digest mismatch")
	}
	acceptedInput, err := plugindispatch.CanonicalJSON(original.Input)
	if err != nil || !bytes.Equal(input, acceptedInput) {
		return fault("original input mismatch")
	}
	if _, err := m.cfg.Contract.Encode(plugindispatch.Response{Kind: "dispatch", Dispatch: &execution}); err != nil {
		return fault("invalid original dispatch facts")
	}
	if operation.Reports == nil || len(operation.Reports) > m.cfg.Contract.Limits.MaxReportRevisions {
		return fault("missing or oversized report inventory")
	}
	if operation.Outcome == nil && operation.RecoveredOutcome == nil && len(operation.Reports) == m.cfg.Contract.Limits.MaxReportRevisions {
		return fault("report inventory consumed the final outcome slot")
	}
	var latest uint64
	for sequence, revision := range operation.Reports {
		value, err := parseSequence(sequence)
		if err != nil {
			return fault("invalid stored report sequence")
		}
		ack := plugindispatch.Ack{OperationID: operation.ID, Sequence: sequence, Revision: revision}
		if _, err := m.cfg.Contract.Encode(plugindispatch.Response{Kind: "ack", Ack: &ack}); err != nil {
			return fault("invalid stored report identity")
		}
		latest = max(latest, value)
	}
	if latest != operation.LatestSequence {
		return fault("stored latest sequence mismatch")
	}
	if !operation.Exposed && (operation.Acknowledged || len(operation.Reports) != 0 || len(operation.Progress) != 0 || len(operation.KnownEffects) != 0 || len(operation.KnownOutputs) != 0) {
		return fault("unexposed execution has accepted evidence")
	}
	if (len(operation.Progress) > 0 || len(operation.KnownEffects) > 0 || len(operation.KnownOutputs) > 0) && len(operation.Reports) == 0 {
		return fault("execution evidence lacks a report")
	}
	if operation.RecoveredOutcome != nil && (operation.Status != Interrupted || !operation.Exposed || len(operation.Reports) == 0) {
		return fault("invalid recovered outcome ownership")
	}
	switch operation.Status {
	case Pending:
		if operation.Outcome != nil || operation.CancellationID != "" || len(operation.Progress) != 0 {
			return fault("invalid Pending facts")
		}
	case InProgress:
		if operation.Outcome != nil || operation.CancellationID != "" || !operation.Exposed || len(operation.Progress) == 0 || len(operation.Reports) == 0 {
			return fault("invalid In progress facts")
		}
	case CancellationRequested:
		if operation.Outcome != nil || !operation.Exposed || operation.CancellationID == "" {
			return fault("invalid Cancellation requested facts")
		}
	case Completed, Failed:
		if !operation.Exposed || len(operation.Reports) == 0 || operation.Outcome == nil || operation.Outcome.Status != string(operation.Status) {
			return fault("invalid definitive outcome facts")
		}
	case Cancelled:
		if operation.Outcome == nil || operation.Outcome.Status != string(Cancelled) || operation.Exposed && len(operation.Reports) == 0 || !operation.Exposed && operation.CancellationID == "" {
			return fault("invalid Cancelled facts")
		}
	case Interrupted:
		if operation.Outcome != nil || !operation.Exposed && operation.CancellationID != "" {
			return fault("invalid Interrupted facts")
		}
	default:
		return fault("unknown stored Operation status")
	}
	if operation.CancellationID != "" {
		cancel := plugindispatch.Cancel{OperationID: operation.ID, CancellationID: operation.CancellationID}
		if _, err := m.cfg.Contract.Encode(plugindispatch.Response{Kind: "cancel", Cancel: &cancel}); err != nil {
			return fault("invalid cancellation identity")
		}
	}
	if len(operation.KnownEffects) > m.cfg.Contract.Limits.MaxEffects || len(operation.KnownOutputs) > m.cfg.Contract.Limits.MaxOutputs {
		return fault("oversized stored fact inventory")
	}
	effects := make(map[string]bool, len(operation.KnownEffects))
	for _, effect := range operation.KnownEffects {
		if effects[effect.ID] {
			return fault("duplicate known effect identity")
		}
		effects[effect.ID] = true
	}
	outputs := make(map[plugindispatch.Output]bool, len(operation.KnownOutputs))
	for _, output := range operation.KnownOutputs {
		if outputs[output] {
			return fault("duplicate known output reference")
		}
		outputs[output] = true
	}
	// Core unions incremental reports. Their bounded fact inventory can exceed
	// one wire frame, so validate individual facts without inventing a cumulative
	// frame requirement or a historical revision.
	facts := []plugindispatch.Evidence{{Progress: operation.Progress}, {Outcome: operation.Outcome}, {Outcome: operation.RecoveredOutcome}}
	for _, effect := range operation.KnownEffects {
		facts = append(facts, plugindispatch.Evidence{Effects: []plugindispatch.Effect{effect}})
	}
	for _, output := range operation.KnownOutputs {
		facts = append(facts, plugindispatch.Evidence{Outputs: []plugindispatch.Output{output}})
	}
	for _, evidence := range facts {
		if len(evidence.Effects) == 0 && len(evidence.Outputs) == 0 && len(evidence.Progress) == 0 && evidence.Outcome == nil {
			continue
		}
		evidence.Execution, evidence.Sequence = execution, "1"
		evidence.Revision = plugindispatch.Revision(evidence)
		if _, err := m.cfg.Contract.Encode(struct {
			Format   int                     `json:"format_version"`
			Evidence plugindispatch.Evidence `json:"evidence"`
		}{m.cfg.Contract.Version, evidence}); err != nil {
			return fault("invalid stored execution evidence")
		}
	}
	if m.recordsReady {
		if err := m.validateStoredOutcomes(operation); err != nil {
			return operationRecord{}, err
		}
	}
	return operation, nil
}

func (m *Module) validateStoredOutcomes(operation operationRecord) error {
	key, err := operation.resultSchemaSource.identity()
	if err != nil {
		return fmt.Errorf("%w: original result schema: %w", ErrIntegrity, err)
	}
	schemas, ok := m.resultSchemas[key]
	if !ok {
		return fmt.Errorf("%w: missing original result schema", ErrIntegrity)
	}
	for _, outcome := range []*plugindispatch.Outcome{operation.Outcome, operation.RecoveredOutcome} {
		if outcome != nil {
			if err := plugindispatch.ValidateOutcome(*outcome, schemas.output, schemas.failure, m.cfg.Contract.Limits.ResultBytes); err != nil {
				return fmt.Errorf("%w: original result schema: %w", ErrIntegrity, err)
			}
		}
	}
	return nil
}
