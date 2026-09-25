package entities

import (
	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

var errUnknownCommand = problem.Invalid("invalid_command_manifest", "The Asset advertises an unsupported Command or scheduling combination.")

// The Protocol catalog currently contains Move To with queued scheduling.
// Keep this check beside the stored Asset manifest so later catalog additions
// are checked on both enrollment and report updates.
func checkManifest(manifest []api.CommandSupport) error {
	seen := make(map[string]bool, len(manifest))
	for _, support := range manifest {
		if support.CommandId != string(api.TaskSubmissionCommandIdMoveTo) || seen[support.CommandId] {
			return errUnknownCommand
		}
		seen[support.CommandId] = true
		for _, scheduling := range support.Scheduling {
			if string(scheduling) != string(api.TaskSubmissionSchedulingQueued) {
				return errUnknownCommand
			}
		}
	}
	return nil
}
