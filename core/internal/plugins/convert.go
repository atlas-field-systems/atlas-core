package plugins

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/operationsdb"
)

func (s *Service) toAPI(row operationsdb.PluginOperation) (api.Operation, error) {
	id, err := uuid.Parse(row.ID)
	if err != nil {
		return api.Operation{}, fmt.Errorf("stored Operation ID %q: %w", row.ID, err)
	}
	submission, err := uuid.Parse(row.SubmissionID)
	if err != nil {
		return api.Operation{}, fmt.Errorf("stored submission ID %q: %w", row.SubmissionID, err)
	}
	operation := api.Operation{
		Id:            id,
		DatasetId:     s.datasets.Current().ID,
		SubmissionId:  submission,
		PluginId:      row.PluginID,
		PluginRelease: row.PluginRelease,
		Capability:    row.Capability,
		Status:        api.OperationStatus(row.Status),
		CreatedAt:     time.UnixMilli(row.CreatedAt).UTC(),
		Output:        nullable.NewNullNullable[map[string]any](),
		Error:         nullable.NewNullNullable[string](),
	}
	if err := json.Unmarshal([]byte(row.Input), &operation.Input); err != nil {
		return api.Operation{}, fmt.Errorf("stored input of %s: %w", row.ID, err)
	}
	if row.Output.Valid {
		var output map[string]any
		if err := json.Unmarshal([]byte(row.Output.String), &output); err != nil {
			return api.Operation{}, fmt.Errorf("stored output of %s: %w", row.ID, err)
		}
		operation.Output.Set(output)
	}
	if row.Error.Valid {
		operation.Error.Set(row.Error.String)
	}
	return operation, nil
}

// Location is where a client reads an attempt.
func Location(operation api.Operation) string {
	return fmt.Sprintf("/plugins/%s/operations/%s", operation.PluginId, operation.Id)
}
