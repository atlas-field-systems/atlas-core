package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/atlas-field-systems/atlas-core/tests/contractfixture/generated/contract"
)

// Only test tooling uses this visitor. Operational mutation handlers always
// return their normal generated response objects and never inject faults.
type fixtureResponse struct {
	kind    string
	fault   string
	version string
	gate    int
}

func (r fixtureResponse) write(w http.ResponseWriter) error {
	w.Header().Set("Atlas-Dataset-ID", datasetID)
	w.Header().Set("Atlas-Protocol-Version", r.version)
	if r.gate != 0 {
		w.Header().Set("Content-Type", "application/json")
		code := "unsupported_protocol"
		message := "Unsupported artificial fixture Protocol edition"
		if r.gate == http.StatusConflict {
			code = "dataset_mismatch"
			message = "Fixture Dataset does not match"
		}
		var correlation contract.Identifier
		if err := correlation.UnmarshalText([]byte("dddddddd-dddd-4ddd-8ddd-dddddddddddd")); err != nil {
			return fmt.Errorf("decode fixed diagnostic response identifier: %w", err)
		}
		var dataset contract.Identifier
		if err := dataset.UnmarshalText([]byte(datasetID)); err != nil {
			return fmt.Errorf("decode fixed response Dataset: %w", err)
		}
		w.WriteHeader(r.gate)
		if err := json.NewEncoder(w).Encode(contract.FixtureResponseError{
			DatasetId: dataset,
			Error:     contract.ErrorInfo{Code: code, Message: message, RequestId: correlation},
		}); err != nil {
			return fmt.Errorf("write fixture context refusal: %w", err)
		}
		return nil
	}
	encoded, err := os.ReadFile(filepath.Join("tests", "contract", "response-fixtures.json"))
	if err != nil {
		return fmt.Errorf("read independent response fixtures: %w", err)
	}
	var fixtures []struct {
		Kind        string            `json:"kind"`
		Fault       string            `json:"fault"`
		Status      int               `json:"status"`
		Body        string            `json:"body"`
		Headers     map[string]string `json:"headers"`
		OmitHeaders []string          `json:"omit_headers"`
	}
	if err := json.Unmarshal(encoded, &fixtures); err != nil {
		return fmt.Errorf("decode independent response fixtures: %w", err)
	}
	for _, fixture := range fixtures {
		if fixture.Kind != r.kind || fixture.Fault != r.fault {
			continue
		}
		for name, value := range fixture.Headers {
			w.Header().Set(name, value)
		}
		omitLength := false
		for _, name := range fixture.OmitHeaders {
			w.Header().Del(name)
			if name == "Content-Type" {
				// A nil entry suppresses net/http's automatic content sniffing.
				w.Header()["Content-Type"] = nil
			}
			omitLength = omitLength || name == "Content-Length"
		}
		w.WriteHeader(fixture.Status)
		if omitLength {
			if err := http.NewResponseController(w).Flush(); err != nil {
				return fmt.Errorf("flush fixture without content length: %w", err)
			}
		}
		if _, err := io.WriteString(w, fixture.Body); err != nil {
			return fmt.Errorf("write response fixture: %w", err)
		}
		return nil
	}
	return fmt.Errorf("unknown test-only response fixture %s/%s", r.kind, r.fault)
}

func (s *fixtureServer) responseFixture(kind string, dataset contract.Identifier, version string, fault *string) fixtureResponse {
	response := fixtureResponse{kind: kind, version: version}
	if fault != nil {
		response.fault = *fault
	}
	if version != "0.1.0" && version != "0.2.0" {
		response.version = protocolVersion
		response.gate = http.StatusUpgradeRequired
	} else if dataset != s.dataset {
		response.gate = http.StatusConflict
	}
	return response
}

func (r fixtureResponse) VisitGetResponseReadResponse(w http.ResponseWriter) error { return r.write(w) }
func (r fixtureResponse) VisitGetResponseMutationResponse(w http.ResponseWriter) error {
	return r.write(w)
}
func (r fixtureResponse) VisitGetResponseErrorResponse(w http.ResponseWriter) error {
	return r.write(w)
}
func (r fixtureResponse) VisitGetResponseOpenapiResponse(w http.ResponseWriter) error {
	return r.write(w)
}
func (r fixtureResponse) VisitGetResponseEmptyResponse(w http.ResponseWriter) error {
	return r.write(w)
}
func (r fixtureResponse) VisitGetResponseBinaryResponse(w http.ResponseWriter) error {
	return r.write(w)
}

func (s *fixtureServer) GetResponseRead(ctx context.Context, request contract.GetResponseReadRequestObject) (contract.GetResponseReadResponseObject, error) {
	return s.responseFixture("read", request.Params.AtlasDatasetID, request.Params.AtlasProtocolVersion, request.Params.Fault), nil
}

func (s *fixtureServer) GetResponseMutation(ctx context.Context, request contract.GetResponseMutationRequestObject) (contract.GetResponseMutationResponseObject, error) {
	return s.responseFixture("mutation", request.Params.AtlasDatasetID, request.Params.AtlasProtocolVersion, request.Params.Fault), nil
}

func (s *fixtureServer) GetResponseError(ctx context.Context, request contract.GetResponseErrorRequestObject) (contract.GetResponseErrorResponseObject, error) {
	return s.responseFixture("error", request.Params.AtlasDatasetID, request.Params.AtlasProtocolVersion, request.Params.Fault), nil
}

func (s *fixtureServer) GetResponseOpenapi(ctx context.Context, request contract.GetResponseOpenapiRequestObject) (contract.GetResponseOpenapiResponseObject, error) {
	return s.responseFixture("openapi", request.Params.AtlasDatasetID, request.Params.AtlasProtocolVersion, request.Params.Fault), nil
}

func (s *fixtureServer) GetResponseEmpty(ctx context.Context, request contract.GetResponseEmptyRequestObject) (contract.GetResponseEmptyResponseObject, error) {
	return s.responseFixture("empty", request.Params.AtlasDatasetID, request.Params.AtlasProtocolVersion, request.Params.Fault), nil
}

func (s *fixtureServer) GetResponseBinary(ctx context.Context, request contract.GetResponseBinaryRequestObject) (contract.GetResponseBinaryResponseObject, error) {
	return s.responseFixture("binary", request.Params.AtlasDatasetID, request.Params.AtlasProtocolVersion, request.Params.Fault), nil
}
