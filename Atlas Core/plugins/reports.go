package plugins

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"

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
		operation, err := load(ctx, q, evidence.Execution.OperationID)
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
			return nil
		}
		if len(operation.Reports) >= m.cfg.Contract.Limits.MaxReportRevisions {
			return ErrLimit
		}
		if evidence.Outcome != nil {
			outcome := evidence.Outcome
			switch outcome.Status {
			case string(Completed):
				if len(outcome.Result) == 0 || len(outcome.Error) != 0 {
					return errors.New("invalid_outcome")
				}
				output, err := plugindispatch.CompileSchema(operation.OutputSchema)
				if err != nil {
					return err
				}
				if err := plugindispatch.ValidateJSON(output, outcome.Result, m.cfg.Contract.Limits.ResultBytes); err != nil {
					return err
				}
			case string(Failed):
				if len(outcome.Error) == 0 || len(outcome.Result) != 0 || len(operation.ErrorSchema) == 0 {
					return errors.New("invalid_outcome")
				}
				failure, err := plugindispatch.CompileSchema(operation.ErrorSchema)
				if err != nil {
					return err
				}
				if err := plugindispatch.ValidateJSON(failure, outcome.Error, m.cfg.Contract.Limits.ResultBytes); err != nil {
					return err
				}
			case string(Cancelled):
				if len(outcome.Result) != 0 || len(outcome.Error) != 0 {
					return errors.New("invalid_outcome")
				}
			default:
				return errors.New("invalid_outcome")
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
		} else if !terminal(operation.Status) && sequence > operation.LatestSequence && len(evidence.Progress) > 0 {
			if operation.Status != CancellationRequested {
				operation.Status = InProgress
			}
			operation.Progress = evidence.Progress
		}
		if sequence > operation.LatestSequence {
			operation.LatestSequence = sequence
		}
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
			if m.cfg.ValidateOutput == nil {
				return errors.New("unresolved_output")
			}
			if err := m.cfg.ValidateOutput(ctx, output); err != nil {
				return errors.New("invalid_output")
			}
			found := false
			for _, known := range operation.KnownOutputs {
				if known == output {
					found = true
				}
			}
			if !found {
				if len(operation.KnownOutputs) >= m.cfg.Contract.Limits.MaxOutputs {
					return ErrLimit
				}
				operation.KnownOutputs = append(operation.KnownOutputs, output)
			}
		}
		operation.Reports[evidence.Sequence] = evidence.Revision
		return save(ctx, q, operation)
	})
	return ack, err
}
