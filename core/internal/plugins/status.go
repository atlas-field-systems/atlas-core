package plugins

import (
	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

// Error text recorded when Core cannot establish an outcome.
const (
	errPreviousRun     = "Core restarted before the outcome was known."
	errRestarted       = "The Plugin restarted before the outcome was known."
	errDispatchUnknown = "Core could not confirm that the Plugin received the Operation; the outcome is unknown."
)

var (
	errTerminal       = problem.Conflict("terminal_operation", "A confirmed outcome cannot change.")
	errFailedNeedsWhy = problem.Invalid("invalid_report", "A failed outcome needs an error, and only an outcome may carry one.")
)

func isTerminal(status api.OperationStatus) bool {
	switch status {
	case api.OperationStatusCompleted, api.OperationStatusCanceled, api.OperationStatusFailed, api.OperationStatusInterrupted:
		return true
	}
	return false
}

// reportedStatus decides the status a Plugin report leaves. Progress during
// a requested cancellation keeps the request visible.
func reportedStatus(current api.OperationStatus, report api.OperationReport) (api.OperationStatus, error) {
	next := api.OperationStatus(report.Status)
	failedWithoutError := next == api.OperationStatusFailed && report.Error == nil
	progressWithError := next == api.OperationStatusInProgress && report.Error != nil
	if failedWithoutError || progressWithError {
		return "", errFailedNeedsWhy
	}
	if next == api.OperationStatusInProgress && current == api.OperationStatusCancellationRequested {
		return current, nil
	}
	return next, nil
}
