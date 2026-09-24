package plugins

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/operationsdb"
	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/registrydb"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
	"github.com/atlas-field-systems/atlas-core/core/internal/storage"
)

// maxUnfinished bounds the attempts Core queues for one Plugin, so a stalled
// Plugin cannot accumulate unbounded work.
const maxUnfinished = 32

// operationList names Operation list cursors in the pagination codec.
const operationList = "operations"

var (
	errOperationNotFound  = problem.NotFound("not_found", "Operation not found.")
	errUnknownCapability  = problem.Invalid("invalid_capability", "The Plugin does not offer this capability.")
	errSubmissionConflict = problem.Conflict("submission_conflict", "The submission ID was already used with different facts.")
	errPluginUnavailable  = problem.Conflict("plugin_unavailable", "The Plugin is not admitting Operations.")
	errPluginBusy         = problem.TooMany("plugin_busy", "The Plugin already has its maximum of unfinished Operations.")
	errNotOwnOperation    = problem.Forbidden("forbidden", "Only the Plugin that owns an Operation may report it.")
)

type operationPosition struct {
	CreatedAt int64  `json:"t"`
	ID        string `json:"i"`
}

// Submit retains a new attempt and dispatches it, or returns the attempt an
// earlier identical submission created.
func (s *Service) Submit(ctx context.Context, pluginID string, submission api.OperationSubmission) (api.Operation, error) {
	if err := s.datasets.RequireCurrent(submission.DatasetId); err != nil {
		return api.Operation{}, err
	}
	facts, input, err := submissionFacts(pluginID, submission)
	if err != nil {
		return api.Operation{}, err
	}
	if existing, found, err := s.retried(ctx, submission.SubmissionId, facts); found || err != nil {
		return existing, err
	}
	plugin, err := s.checkAdmission(ctx, pluginID, submission)
	if err != nil {
		return api.Operation{}, err
	}
	created, err := s.create(ctx, plugin, submission, facts, input)
	if storage.IsConstraint(err) {
		return s.retriedAfterConflict(ctx, submission.SubmissionId, facts)
	}
	if err != nil {
		return api.Operation{}, err
	}
	s.dispatch(plugin, created)
	return s.toAPI(created)
}

func (s *Service) retried(ctx context.Context, submissionID uuid.UUID, facts []byte) (api.Operation, bool, error) {
	existing, err := s.queries.GetOperationBySubmission(ctx, submissionID.String())
	if errors.Is(err, sql.ErrNoRows) {
		return api.Operation{}, false, nil
	}
	if err != nil {
		return api.Operation{}, true, fmt.Errorf("read submission %s: %w", submissionID, err)
	}
	if !bytes.Equal(existing.FactsDigest, facts) {
		return api.Operation{}, true, errSubmissionConflict
	}
	operation, err := s.toAPI(existing)
	return operation, true, err
}

// retriedAfterConflict resolves a concurrent identical submission.
func (s *Service) retriedAfterConflict(ctx context.Context, submissionID uuid.UUID, facts []byte) (api.Operation, error) {
	existing, found, err := s.retried(ctx, submissionID, facts)
	if !found && err == nil {
		return api.Operation{}, errSubmissionConflict
	}
	return existing, err
}

// checkAdmission validates the capability and input and checks the Plugin
// can take another attempt.
func (s *Service) checkAdmission(ctx context.Context, pluginID string, submission api.OperationSubmission) (registrydb.Plugin, error) {
	plugin, err := s.registry.plugin(ctx, pluginID)
	if err != nil {
		return registrydb.Plugin{}, err
	}
	if err := s.checkInput(ctx, pluginID, submission); err != nil {
		return registrydb.Plugin{}, err
	}
	runtime, err := s.runtime(ctx, s.queries, pluginID)
	if err != nil {
		return registrydb.Plugin{}, err
	}
	if s.availability(pluginID, runtime) != api.PluginAvailabilityAvailable {
		return registrydb.Plugin{}, errPluginUnavailable
	}
	unfinished, err := s.queries.CountUnfinished(ctx, pluginID)
	if err != nil {
		return registrydb.Plugin{}, fmt.Errorf("count unfinished Operations of %s: %w", pluginID, err)
	}
	if unfinished >= maxUnfinished {
		return registrydb.Plugin{}, errPluginBusy
	}
	return plugin, nil
}

// checkInput applies the capability's manifest input schema.
func (s *Service) checkInput(ctx context.Context, pluginID string, submission api.OperationSubmission) error {
	capability, err := s.registry.queries.GetCapability(ctx, registrydb.GetCapabilityParams{PluginID: pluginID, Name: submission.Capability})
	if errors.Is(err, sql.ErrNoRows) {
		return errUnknownCapability
	}
	if err != nil {
		return fmt.Errorf("read capability %s of %s: %w", submission.Capability, pluginID, err)
	}
	schema, err := parseSchema(json.RawMessage(capability.InputSchema))
	if err != nil {
		return fmt.Errorf("stored input schema of %s: %w", submission.Capability, err)
	}
	if err := schema.VisitJSON(submission.Input); err != nil {
		return problem.Invalid("invalid_input", "The input does not match the capability's schema: "+schemaReason(err)+".")
	}
	return nil
}

func (s *Service) create(ctx context.Context, plugin registrydb.Plugin, submission api.OperationSubmission, facts, input []byte) (operationsdb.PluginOperation, error) {
	params := operationsdb.CreateOperationParams{
		ID:            uuid.NewString(),
		SubmissionID:  submission.SubmissionId.String(),
		FactsDigest:   facts,
		PluginID:      plugin.ID,
		PluginRelease: plugin.Release,
		Capability:    submission.Capability,
		Input:         string(input),
		CreatedAt:     time.Now().UnixMilli(),
	}
	if err := s.queries.CreateOperation(ctx, params); err != nil {
		return operationsdb.PluginOperation{}, fmt.Errorf("retain Operation %s: %w", params.ID, err)
	}
	return s.queries.GetOperation(ctx, operationsdb.GetOperationParams{PluginID: plugin.ID, ID: params.ID})
}

// Operation reads one retained attempt.
func (s *Service) Operation(ctx context.Context, pluginID string, id uuid.UUID) (api.Operation, error) {
	row, err := s.operation(ctx, s.queries, pluginID, id.String())
	if err != nil {
		return api.Operation{}, err
	}
	return s.toAPI(row)
}

func (s *Service) operation(ctx context.Context, queries *operationsdb.Queries, pluginID, id string) (operationsdb.PluginOperation, error) {
	row, err := queries.GetOperation(ctx, operationsdb.GetOperationParams{PluginID: pluginID, ID: id})
	if errors.Is(err, sql.ErrNoRows) {
		return operationsdb.PluginOperation{}, errOperationNotFound
	}
	if err != nil {
		return operationsdb.PluginOperation{}, fmt.Errorf("read Operation %s: %w", id, err)
	}
	return row, nil
}

// Operations lists a Plugin's retained attempts, newest first.
func (s *Service) Operations(ctx context.Context, pluginID string, cursor *string, limit int) (api.OperationPage, error) {
	if _, err := s.registry.plugin(ctx, pluginID); err != nil {
		return api.OperationPage{}, err
	}
	before := operationPosition{CreatedAt: time.Now().Add(time.Hour).UnixMilli()}
	if cursor != nil {
		if err := s.cursors().Decode(*cursor, operationList, &before); err != nil {
			return api.OperationPage{}, err
		}
	}
	rows, err := s.queries.ListOperationsBefore(ctx, operationsdb.ListOperationsBeforeParams{PluginID: pluginID, CreatedAt: before.CreatedAt, ID: before.ID, Limit: int64(limit + 1)})
	if err != nil {
		return api.OperationPage{}, fmt.Errorf("list Operations of %s: %w", pluginID, err)
	}
	return s.operationPage(rows, limit)
}

func (s *Service) operationPage(rows []operationsdb.PluginOperation, limit int) (api.OperationPage, error) {
	page := api.OperationPage{Items: make([]api.Operation, 0, len(rows))}
	if len(rows) > limit {
		rows = rows[:limit]
		last := rows[limit-1]
		next, err := s.cursors().Encode(operationList, operationPosition{CreatedAt: last.CreatedAt, ID: last.ID})
		if err != nil {
			return api.OperationPage{}, err
		}
		page.NextCursor = &next
	}
	for _, row := range rows {
		operation, err := s.toAPI(row)
		if err != nil {
			return api.OperationPage{}, err
		}
		page.Items = append(page.Items, operation)
	}
	return page, nil
}

// Report records a Plugin's progress or outcome for its own attempt.
func (s *Service) Report(ctx context.Context, caller identity.Caller, pluginID string, id uuid.UUID, report api.OperationReport) (api.Operation, error) {
	if caller.Kind != identity.Plugin || caller.ID != pluginID {
		return api.Operation{}, errNotOwnOperation
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return api.Operation{}, err
	}
	defer tx.Rollback()
	queries := s.queries.WithTx(tx)
	row, err := s.operation(ctx, queries, pluginID, id.String())
	if err != nil {
		return api.Operation{}, err
	}
	updated, err := applyReport(row, report)
	if err != nil {
		return api.Operation{}, err
	}
	if err := queries.SetOutcome(ctx, operationsdb.SetOutcomeParams{Status: updated.Status, Output: updated.Output, Error: updated.Error, ID: updated.ID}); err != nil {
		return api.Operation{}, fmt.Errorf("record report for Operation %s: %w", id, err)
	}
	if err := tx.Commit(); err != nil {
		return api.Operation{}, err
	}
	return s.toAPI(updated)
}

// applyReport returns the attempt after a report. Repeating a terminal
// outcome changes nothing; changing it conflicts.
func applyReport(row operationsdb.PluginOperation, report api.OperationReport) (operationsdb.PluginOperation, error) {
	updated := row
	if report.Output != nil {
		encoded, err := json.Marshal(*report.Output)
		if err != nil {
			return row, fmt.Errorf("encode reported output: %w", err)
		}
		updated.Output = sql.NullString{String: string(encoded), Valid: true}
	}
	status, err := reportedStatus(api.OperationStatus(row.Status), report)
	if err != nil {
		return row, err
	}
	updated.Status = string(status)
	if report.Error != nil {
		updated.Error = sql.NullString{String: *report.Error, Valid: true}
	}
	if isTerminal(api.OperationStatus(row.Status)) {
		if updated.Status != row.Status || updated.Output != row.Output || updated.Error != row.Error {
			return row, errTerminal
		}
	}
	return updated, nil
}

// submissionFacts fingerprints what a retry must repeat, and encodes the input.
func submissionFacts(pluginID string, submission api.OperationSubmission) ([]byte, []byte, error) {
	input, err := json.Marshal(submission.Input)
	if err != nil {
		return nil, nil, fmt.Errorf("encode Operation input: %w", err)
	}
	facts, err := json.Marshal(struct {
		Plugin     string          `json:"plugin"`
		Capability string          `json:"capability"`
		Input      json.RawMessage `json:"input"`
	}{pluginID, submission.Capability, input})
	if err != nil {
		return nil, nil, fmt.Errorf("encode submission facts: %w", err)
	}
	digest := sha256.Sum256(facts)
	return digest[:], input, nil
}

func schemaReason(err error) string {
	message := err.Error()
	if line, _, found := strings.Cut(message, "\n"); found {
		return line
	}
	return message
}
