package main

import (
	"context"
	"errors"

	"github.com/atlas-field-systems/atlas-core/tests/contractfixture/generated/contract"
)

// This route qualifies structural fidelity through real storage. It does not
// apply Asset authority, freshness, ordering or report acceptance rules.
func (s *fixtureServer) PutReport(ctx context.Context, request contract.PutReportRequestObject) (contract.PutReportResponseObject, error) {
	if request.Body == nil {
		return nil, errors.New("validated fixture report body missing")
	}
	if err := storeJSON(ctx, s.queries, "report", *request.Body); err != nil {
		return nil, err
	}
	return contract.PutReport200JSONResponse{
		Body:    contract.FixturePositionReportMutationResponse{DatasetId: s.dataset, Data: *request.Body, CommitCursor: "fixture:report:1"},
		Headers: contract.PutReport200ResponseHeaders{AtlasDatasetID: s.dataset, AtlasProtocolVersion: request.Params.AtlasProtocolVersion},
	}, nil
}

func (s *fixtureServer) GetReport(ctx context.Context, request contract.GetReportRequestObject) (contract.GetReportResponseObject, error) {
	report, err := loadJSON[contract.FixturePositionReport](ctx, s.queries, "report")
	if err != nil {
		return nil, err
	}
	return contract.GetReport200JSONResponse{
		Body:    contract.FixturePositionReportResponse{DatasetId: s.dataset, Data: report},
		Headers: contract.GetReport200ResponseHeaders{AtlasDatasetID: s.dataset, AtlasProtocolVersion: request.Params.AtlasProtocolVersion},
	}, nil
}
