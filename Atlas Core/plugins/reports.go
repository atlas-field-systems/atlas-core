package plugins

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	"github.com/atlas-field-systems/atlas-core/plugindispatch"
	"github.com/atlas-field-systems/atlas-core/plugins/generated/storage"
)

func (m *Module) acceptEvidence(ctx context.Context, active *runtime, evidence plugindispatch.Evidence) (plugindispatch.Ack, error) {
	ack := plugindispatch.Ack{OperationID: evidence.Execution.OperationID, Sequence: evidence.Sequence, Revision: evidence.Revision}
	if evidence.Revision != plugindispatch.Revision(evidence) {
		return ack, errors.New("evidence_revision_mismatch")
	}
	sequence, err := parseSequence(evidence.Sequence)
	if err != nil {
		return ack, err
	}
	err = m.commit(ctx, func(q *storage.Queries) error {
		operation, err := m.load(ctx, q, evidence.Execution.OperationID)
		if err != nil {
			return err
		}
		original := operation.Execution.Binding
		current := active.host.Binding
		if !operation.Exposed || !plugindispatch.SameDispatch(operation.Execution, evidence.Execution) || original.PluginID != current.PluginID || original.PrincipalID != current.PrincipalID || original.DatasetID != current.DatasetID {
			return ErrAuthority
		}
		if original != current && !terminal(operation.Status) {
			return ErrAuthority
		}
		if prior, found := operation.Reports[evidence.Sequence]; found {
			if prior != evidence.Revision {
				return errors.New("report_conflict")
			}
			if original == current && !operation.Acknowledged {
				operation.Acknowledged = true
				return save(ctx, q, operation)
			}
			return nil
		}
		if terminal(operation.Status) && operation.Status != Interrupted {
			return ErrTerminalConflict
		}
		if sequence <= operation.LatestSequence {
			return errors.New("stale_report")
		}
		limit := m.cfg.Contract.Limits.MaxReportRevisions
		if evidence.Outcome == nil {
			limit-- // A final outcome always has one remaining report slot.
		}
		if len(operation.Reports) >= limit {
			return ErrLimit
		}
		if evidence.Outcome != nil {
			outcome := evidence.Outcome
			key, err := operation.resultSchemaSource.identity()
			if err != nil {
				return fmt.Errorf("%w: original result schema: %w", ErrIntegrity, err)
			}
			schemas, exists := m.resultSchemas[key]
			if !exists {
				return errors.New("missing_original_result_schema")
			}
			if err := plugindispatch.ValidateOutcome(*outcome, schemas.output, schemas.failure, m.cfg.Contract.Limits.ResultBytes); err != nil {
				return err
			}
			retained := operation.Outcome
			if operation.Status == Interrupted {
				retained = operation.RecoveredOutcome
			}
			if retained != nil {
				left, _ := json.Marshal(retained)
				right, _ := json.Marshal(outcome)
				if !bytes.Equal(left, right) {
					return ErrTerminalConflict
				}
			}
			if operation.Status == Interrupted {
				operation.RecoveredOutcome = outcome
			} else if !terminal(operation.Status) {
				operation.Status = Status(outcome.Status)
				operation.Outcome = outcome
			}
		} else if !terminal(operation.Status) && len(evidence.Progress) > 0 {
			if operation.Status != CancellationRequested {
				operation.Status = InProgress
			}
			operation.Progress = evidence.Progress
		}
		operation.LatestSequence = sequence
		for _, effect := range evidence.Effects {
			found := false
			for _, known := range operation.KnownEffects {
				if known.ID == effect.ID {
					if known != effect {
						return errors.New("effect_conflict")
					}
					found = true
				}
			}
			if !found {
				if len(operation.KnownEffects) >= m.cfg.Contract.Limits.MaxEffects {
					return ErrLimit
				}
				operation.KnownEffects = append(operation.KnownEffects, effect)
			}
		}
		for _, output := range evidence.Outputs {
			if slices.Contains(operation.KnownOutputs, output) {
				continue
			}
			if m.cfg.ValidateOutput == nil {
				return errors.New("unresolved_output")
			}
			if err := m.cfg.ValidateOutput(ctx, output); err != nil {
				return errors.New("invalid_output")
			}
			if len(operation.KnownOutputs) >= m.cfg.Contract.Limits.MaxOutputs {
				return ErrLimit
			}
			operation.KnownOutputs = append(operation.KnownOutputs, output)
		}
		// Same-runtime evidence proves acceptance even if dispatch_ack was lost.
		// Replacement evidence retains its original execution binding.
		if original == current {
			operation.Acknowledged = true
		}
		operation.Reports[evidence.Sequence] = evidence.Revision
		return save(ctx, q, operation)
	})
	return ack, err
}
