package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"github.com/atlas-field-systems/atlas-core/httpcontract"
	"github.com/atlas-field-systems/atlas-core/tests/contractfixture/generated/contract"
	"github.com/atlas-field-systems/atlas-core/tests/contractfixture/generated/storage"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
)

func (s *fixtureServer) initializePatch(ctx context.Context) error {
	encoded, err := os.ReadFile(filepath.Join("tests", "contract", "patch.fixtures.json"))
	if err != nil {
		return fmt.Errorf("read patch fixture seed: %w", err)
	}
	var seed struct {
		Initial contract.FixturePatchResource `json:"initial"`
	}
	if err := json.Unmarshal(encoded, &seed); err != nil {
		return fmt.Errorf("decode patch fixture seed: %w", err)
	}
	return s.savePatch(ctx, seed.Initial)
}

func (s *fixtureServer) savePatch(ctx context.Context, resource contract.FixturePatchResource) error {
	encoded, err := json.Marshal(resource)
	if err != nil {
		return fmt.Errorf("encode patch fixture: %w", err)
	}
	if err := s.queries.PutValue(ctx, storage.PutValueParams{Key: "patch", Value: string(encoded)}); err != nil {
		return fmt.Errorf("store patch fixture: %w", err)
	}
	return nil
}

func (s *fixtureServer) readPatch(ctx context.Context) (contract.FixturePatchResource, error) {
	encoded, err := s.queries.ReadValue(ctx, "patch")
	if err != nil {
		return contract.FixturePatchResource{}, fmt.Errorf("read patch fixture: %w", err)
	}
	var resource contract.FixturePatchResource
	if err := json.Unmarshal([]byte(encoded), &resource); err != nil {
		return resource, fmt.Errorf("decode stored patch fixture: %w", err)
	}
	return resource, nil
}

func (s *fixtureServer) GetPatchResource(ctx context.Context, request contract.GetPatchResourceRequestObject) (contract.GetPatchResourceResponseObject, error) {
	resource, err := s.readPatch(ctx)
	if err != nil {
		return nil, err
	}
	return contract.GetPatchResource200JSONResponse{
		Body:    contract.FixturePatchResponse{DatasetId: s.dataset, Data: resource},
		Headers: contract.GetPatchResource200ResponseHeaders{AtlasDatasetID: s.dataset, AtlasProtocolVersion: request.Params.AtlasProtocolVersion},
	}, nil
}

func (s *fixtureServer) PatchResource(ctx context.Context, request contract.PatchResourceRequestObject) (contract.PatchResourceResponseObject, error) {
	if request.Body == nil {
		return nil, errors.New("validated patch fixture body missing")
	}
	resource, err := s.readPatch(ctx)
	if err != nil {
		return nil, err
	}
	encoded, err := mergePatchCandidate(resource, *request.Body)
	if err != nil {
		return nil, err
	}
	candidate, err := http.NewRequestWithContext(ctx, http.MethodPatch, "/", bytes.NewReader(encoded))
	if err != nil {
		return nil, fmt.Errorf("construct patch candidate validation: %w", err)
	}
	candidate.Header.Set("Content-Type", "application/json")
	validation := &openapi3filter.RequestValidationInput{Request: candidate, Options: &openapi3filter.Options{SkipSettingDefaults: true}}
	body := &openapi3.RequestBody{Required: true, Content: openapi3.Content{"application/json": &openapi3.MediaType{Schema: s.patchSchema}}}
	if err := openapi3filter.ValidateRequestBody(ctx, validation, body); err != nil {
		return patchRejection{}, nil
	}
	if err := json.Unmarshal(encoded, &resource); err != nil {
		return nil, fmt.Errorf("decode validated patch candidate: %w", err)
	}
	if err := s.savePatch(ctx, resource); err != nil {
		return nil, err
	}
	return contract.PatchResource200JSONResponse{
		Body:    contract.FixturePatchMutationResponse{DatasetId: s.dataset, Data: resource, CommitCursor: "fixture:commit:patch"},
		Headers: contract.PatchResource200ResponseHeaders{AtlasDatasetID: s.dataset, AtlasProtocolVersion: request.Params.AtlasProtocolVersion},
	}, nil
}

// Only the illustrative component merges recursively. Position replaces as a
// complete pair, so validation cannot borrow an omitted coordinate from storage.
func mergePatchCandidate(resource contract.FixturePatchResource, patch contract.FixturePatch) ([]byte, error) {
	encoded, err := json.Marshal(resource)
	if err != nil {
		return nil, fmt.Errorf("encode current patch resource: %w", err)
	}
	current := make(map[string]json.RawMessage)
	if err := json.Unmarshal(encoded, &current); err != nil {
		return nil, fmt.Errorf("decode current patch fields: %w", err)
	}
	encoded, err = json.Marshal(patch)
	if err != nil {
		return nil, fmt.Errorf("encode supplied patch: %w", err)
	}
	update := make(map[string]json.RawMessage)
	if err := json.Unmarshal(encoded, &update); err != nil {
		return nil, fmt.Errorf("decode supplied patch fields: %w", err)
	}
	for name, value := range update {
		if name == "fixture_component" && !bytes.Equal(value, []byte("null")) {
			component := make(map[string]json.RawMessage)
			if existing := current[name]; len(existing) > 0 && !bytes.Equal(existing, []byte("null")) {
				if err := json.Unmarshal(existing, &component); err != nil {
					return nil, fmt.Errorf("decode current illustrative component: %w", err)
				}
			}
			fields := make(map[string]json.RawMessage)
			if err := json.Unmarshal(value, &fields); err != nil {
				return nil, fmt.Errorf("decode illustrative component update: %w", err)
			}
			for field, supplied := range fields {
				component[field] = supplied
			}
			value, err = json.Marshal(component)
			if err != nil {
				return nil, fmt.Errorf("encode illustrative component candidate: %w", err)
			}
		}
		current[name] = value
	}
	encoded, err = json.Marshal(current)
	if err != nil {
		return nil, fmt.Errorf("encode complete patch candidate: %w", err)
	}
	return encoded, nil
}

type patchRejection struct{}

func (patchRejection) VisitPatchResourceResponse(w http.ResponseWriter) error {
	httpcontract.WriteError(w, http.StatusBadRequest, "invalid_request", "Complete patch result is invalid for PATCH /__fixture/patch/{fixture_id}")
	return nil
}
