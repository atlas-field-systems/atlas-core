package systemoperations

import (
	"context"
	"github.com/atlas-field-systems/atlas-core/writecommit"
	"strconv"
)

// EvidenceSnapshot is a private integration/maintenance observation. Module
// owners supply their counts inside one read boundary; callers never read SQL.
type EvidenceSnapshot struct {
	DatasetID, CommitCursor                string
	Changes, Activities, Reports, Movement int64
}

func (c *Core) InspectEvidence(ctx context.Context) (value EvidenceSnapshot, err error) {
	err = c.boundary.Read(ctx, "", func(commit *writecommit.Commit) error {
		journal, e := c.boundary.Journal(ctx, commit)
		if e != nil {
			return e
		}
		reports, e := c.entities.Evidence(ctx, commit)
		if e != nil {
			return e
		}
		value = EvidenceSnapshot{commit.Metadata.DatasetID, strconv.FormatInt(commit.Metadata.Position, 10), journal.Changes, journal.Activities, reports.Reports, reports.Movement}
		return nil
	})
	return
}

// InspectActivity is owner/test-only evidence; no public Activity API is added in S1.
func (c *Core) InspectActivity(ctx context.Context) ([]writecommit.Activity, error) {
	var values []writecommit.Activity
	err := c.boundary.Read(ctx, "", func(commit *writecommit.Commit) error {
		var e error
		values, e = c.boundary.ActivityFacts(ctx, commit)
		return e
	})
	return values, err
}
