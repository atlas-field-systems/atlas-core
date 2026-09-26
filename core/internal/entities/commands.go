package entities

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

var errUnknownCommand = problem.Invalid("invalid_command_manifest", "The Asset advertises an unsupported Command or scheduling combination.")

//go:embed command-catalog.generated.json
var commandCatalog []byte

type commandDefinition struct {
	Scheduling []api.CommandSupportScheduling `json:"scheduling"`
}

// Keep manifest validation tied to the Protocol catalog and its executable
// TaskSubmission wire values, without a second authored Command list in Core.
func checkManifest(manifest []api.CommandSupport) error {
	var catalog map[string]commandDefinition
	if err := json.Unmarshal(commandCatalog, &catalog); err != nil {
		return fmt.Errorf("decode generated Command Catalog: %w", err)
	}
	seen := make(map[string]bool, len(manifest))
	for _, support := range manifest {
		definition, known := catalog[support.CommandId]
		if !known || !api.TaskSubmissionCommandId(support.CommandId).Valid() || seen[support.CommandId] {
			return errUnknownCommand
		}
		seen[support.CommandId] = true
		for _, scheduling := range support.Scheduling {
			if !slices.Contains(definition.Scheduling, scheduling) || !api.TaskSubmissionScheduling(scheduling).Valid() {
				return errUnknownCommand
			}
		}
	}
	return nil
}
