package entities

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/entities/internal/db"
	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

var (
	errNotOwnAsset      = problem.Forbidden("forbidden", "Only the assigned Asset may report its state.")
	errReportConflict   = problem.Conflict("report_conflict", "The report ID was already used with different facts.")
	errReportOutOfOrder = problem.Conflict("report_out_of_order", "The report sequence is not newer than the last accepted report.")
)

// report identifies one Asset-originated change for retry and ordering.
type report struct {
	assetID  string
	reportID string
	sequence int64
	digest   []byte
}

// applyFunc writes a fresh report's changes inside the report transaction.
type applyFunc func(ctx context.Context, queries *db.Queries, receivedAt int64) error

// ReportStatus records an Asset's own operational status.
func (s *Service) ReportStatus(ctx context.Context, caller identity.Caller, assetID string, status api.AssetStatusReport) (api.Entity, error) {
	if err := s.checkReporter(caller, assetID, status.DatasetId); err != nil {
		return api.Entity{}, err
	}
	accepted, err := newReport(assetID, status.ReportId.String(), status.Sequence, status)
	if err != nil {
		return api.Entity{}, err
	}
	return s.applyReport(ctx, accepted, func(ctx context.Context, queries *db.Queries, receivedAt int64) error {
		return setStatus(ctx, queries, assetID, status.Status, receivedAt)
	})
}

// Report records a check-in or partial update from the Asset itself. See
// the Protocol AssetReport schema for the merge rules.
func (s *Service) Report(ctx context.Context, caller identity.Caller, assetID string, update api.AssetReport) (api.Entity, error) {
	if err := s.checkReporter(caller, assetID, update.DatasetId); err != nil {
		return api.Entity{}, err
	}
	accepted, err := newReport(assetID, update.ReportId.String(), update.Sequence, update)
	if err != nil {
		return api.Entity{}, err
	}
	return s.applyReport(ctx, accepted, func(ctx context.Context, queries *db.Queries, receivedAt int64) error {
		current, err := queries.GetEntity(ctx, assetID)
		if err != nil {
			return fmt.Errorf("read Entity %s: %w", assetID, err)
		}
		merged, err := mergeReport(current, update)
		if err != nil {
			return err
		}
		if err := queries.SetComponents(ctx, merged); err != nil {
			return fmt.Errorf("update components of Asset %s: %w", assetID, err)
		}
		if update.Components != nil && update.Components.Status != nil {
			return setStatus(ctx, queries, assetID, update.Components.Status.Value, receivedAt)
		}
		return nil
	})
}

func setStatus(ctx context.Context, queries *db.Queries, assetID string, status api.AssetStatus, receivedAt int64) error {
	params := db.SetStatusParams{Status: string(status), StatusReportedAt: sql.NullInt64{Int64: receivedAt, Valid: true}, ID: assetID}
	if err := queries.SetStatus(ctx, params); err != nil {
		return fmt.Errorf("set status of Asset %s: %w", assetID, err)
	}
	return nil
}

func (s *Service) checkReporter(caller identity.Caller, assetID string, datasetID uuid.UUID) error {
	if caller.Kind != identity.Asset || caller.ID != assetID {
		return errNotOwnAsset
	}
	return s.datasets.RequireCurrent(datasetID)
}

func newReport(assetID, reportID string, sequence int64, facts any) (report, error) {
	encoded, err := json.Marshal(facts)
	if err != nil {
		return report{}, fmt.Errorf("encode report facts: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return report{assetID: assetID, reportID: reportID, sequence: sequence, digest: digest[:]}, nil
}

// applyReport applies a fresh report, records contact and publishes the
// change, or returns the current Entity unchanged for a resent report.
// Reports apply in increasing sequence order.
func (s *Service) applyReport(ctx context.Context, accepted report, apply applyFunc) (api.Entity, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return api.Entity{}, err
	}
	defer tx.Rollback()
	queries := s.queries.WithTx(tx)
	if resent, err := checkResent(ctx, queries, accepted); resent || err != nil {
		if err != nil {
			return api.Entity{}, err
		}
		return s.read(ctx, queries, accepted.assetID)
	}
	if err := checkOrder(ctx, queries, accepted); err != nil {
		return api.Entity{}, err
	}
	if err := record(ctx, queries, accepted, apply); err != nil {
		return api.Entity{}, err
	}
	entity, err := s.publish(ctx, tx, accepted.assetID, api.Update)
	if err != nil {
		return api.Entity{}, err
	}
	return entity, s.changes.Commit(tx)
}

// AcceptTaskReport records fresh assigned-Asset contact within a Task report's
// transaction. The caller commits the Entity and any Task change together.
// A matching report retry does not refresh contact or append another change.
func (s *Service) AcceptTaskReport(ctx context.Context, tx *sql.Tx, caller identity.Caller, assetID string, datasetID uuid.UUID, reportID string, sequence int64, facts any) (api.Entity, bool, error) {
	if err := s.checkReporter(caller, assetID, datasetID); err != nil {
		return api.Entity{}, false, err
	}
	accepted, err := newReport(assetID, reportID, sequence, facts)
	if err != nil {
		return api.Entity{}, false, err
	}
	queries := s.queries.WithTx(tx)
	if resent, err := checkResent(ctx, queries, accepted); resent || err != nil {
		if err != nil {
			return api.Entity{}, false, err
		}
		entity, err := s.read(ctx, queries, assetID)
		return entity, true, err
	}
	if err := checkOrder(ctx, queries, accepted); err != nil {
		return api.Entity{}, false, err
	}
	if err := record(ctx, queries, accepted, func(context.Context, *db.Queries, int64) error { return nil }); err != nil {
		return api.Entity{}, false, err
	}
	entity, err := s.publish(ctx, tx, assetID, api.Update)
	return entity, false, err
}

func checkResent(ctx context.Context, queries *db.Queries, accepted report) (bool, error) {
	earlier, err := queries.GetReport(ctx, accepted.reportID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read report %s: %w", accepted.reportID, err)
	}
	if earlier.AssetID != accepted.assetID || !bytes.Equal(earlier.FactsDigest, accepted.digest) {
		return false, errReportConflict
	}
	return true, nil
}

func checkOrder(ctx context.Context, queries *db.Queries, accepted report) error {
	current, err := queries.GetEntity(ctx, accepted.assetID)
	if errors.Is(err, sql.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return fmt.Errorf("read Entity %s: %w", accepted.assetID, err)
	}
	if accepted.sequence <= current.LastReportSequence {
		return errReportOutOfOrder
	}
	return nil
}

func record(ctx context.Context, queries *db.Queries, accepted report, apply applyFunc) error {
	receivedAt := time.Now().UnixMilli()
	if err := apply(ctx, queries, receivedAt); err != nil {
		return err
	}
	contact := db.RecordContactParams{ReceivedAt: sql.NullInt64{Int64: receivedAt, Valid: true}, Sequence: accepted.sequence, ID: accepted.assetID}
	if err := queries.RecordContact(ctx, contact); err != nil {
		return fmt.Errorf("record contact for Asset %s: %w", accepted.assetID, err)
	}
	params := db.CreateReportParams{ReportID: accepted.reportID, AssetID: accepted.assetID, Sequence: accepted.sequence, FactsDigest: accepted.digest}
	if err := queries.CreateReport(ctx, params); err != nil {
		return fmt.Errorf("record report %s: %w", accepted.reportID, err)
	}
	return nil
}
