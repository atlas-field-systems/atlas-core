package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"

	"github.com/atlas-field-systems/atlas-core/httpcontract"
	"github.com/atlas-field-systems/atlas-core/tests/contractfixture/generated/contract"
)

// This finite limit qualifies the binding adapter, not an Object size policy.
const fixtureContentLimit int64 = 1024

type fixtureContentError struct {
	status  int
	code    string
	message string
}

func (response fixtureContentError) VisitPutFixtureContentResponse(w http.ResponseWriter) error {
	httpcontract.WriteError(w, response.status, response.code, response.message)
	return nil
}

func (response fixtureContentError) VisitGetFixtureContentResponse(w http.ResponseWriter) error {
	httpcontract.WriteError(w, response.status, response.code, response.message)
	return nil
}

// Replacement is a test-only observable rule. Each attempt owns its private
// file; a rejected transfer leaves the previously selected content unchanged.
func (s *fixtureServer) PutFixtureContent(ctx context.Context, request contract.PutFixtureContentRequestObject) (response contract.PutFixtureContentResponseObject, result error) {
	attempt, err := os.CreateTemp(s.contentDir, "attempt-")
	if err != nil {
		return nil, fmt.Errorf("create private fixture attempt: %w", err)
	}
	open := true
	defer func() {
		if open {
			result = errors.Join(result, attempt.Close())
		}
		if err := os.Remove(attempt.Name()); err != nil && !errors.Is(err, os.ErrNotExist) {
			result = errors.Join(result, fmt.Errorf("remove private fixture attempt: %w", err))
		}
	}()
	digest := sha256.New()
	length, err := io.Copy(io.MultiWriter(attempt, digest), request.Body)
	if err != nil {
		var maximum *http.MaxBytesError
		if errors.As(err, &maximum) {
			return fixtureContentError{http.StatusRequestEntityTooLarge, "payload_too_large", "Fixture content exceeds the 1024-byte bound"}, nil
		}
		return nil, fmt.Errorf("stream private fixture attempt: %w", err)
	}
	open = false
	if err := attempt.Close(); err != nil {
		return nil, fmt.Errorf("close private fixture attempt: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("fixture transfer ended before selection: %w", err)
	}
	if err := os.Rename(attempt.Name(), s.contentPath(request.ContentId)); err != nil {
		return nil, fmt.Errorf("select complete fixture content: %w", err)
	}
	return contract.PutFixtureContent200JSONResponse{
		Body: contract.FixtureContentReceipt{DatasetId: s.dataset, CommitCursor: "fixture:content:1", Data: contract.FixtureContentMetadata{
			ByteLength: strconv.FormatInt(length, 10), Sha256: fmt.Sprintf("%x", digest.Sum(nil)),
		}},
		Headers: contract.PutFixtureContent200ResponseHeaders{AtlasDatasetID: s.dataset, AtlasProtocolVersion: request.Params.AtlasProtocolVersion},
	}, nil
}

func (s *fixtureServer) contentPath(identifier contract.Identifier) string {
	return filepath.Join(s.contentDir, identifier.String()+".bin")
}

type fixtureContentResponse struct {
	contract.GetFixtureContent200ApplicationoctetStreamResponse
	file *os.File
}

func (response fixtureContentResponse) VisitGetFixtureContentResponse(w http.ResponseWriter) error {
	return errors.Join(response.GetFixtureContent200ApplicationoctetStreamResponse.VisitGetFixtureContentResponse(w), response.file.Close())
}

func (s *fixtureServer) GetFixtureContent(ctx context.Context, request contract.GetFixtureContentRequestObject) (contract.GetFixtureContentResponseObject, error) {
	file, err := os.Open(s.contentPath(request.ContentId))
	if errors.Is(err, os.ErrNotExist) {
		return fixtureContentError{http.StatusNotFound, "content_missing", "Fixture content has not been stored"}, nil
	}
	if err != nil {
		return nil, fmt.Errorf("open private fixture content: %w", err)
	}
	digest := sha256.New()
	length, err := io.Copy(digest, file)
	if err != nil {
		return nil, errors.Join(fmt.Errorf("read private fixture content: %w", err), file.Close())
	}
	// A SectionReader leaves close ownership with the response adapter, which
	// checks it even when copying the response fails. The generated visitor's
	// automatic io.ReadCloser close would otherwise discard that close error.
	return fixtureContentResponse{
		GetFixtureContent200ApplicationoctetStreamResponse: contract.GetFixtureContent200ApplicationoctetStreamResponse{
			Body: io.NewSectionReader(file, 0, length), ContentLength: length,
			Headers: contract.GetFixtureContent200ResponseHeaders{
				AtlasDatasetID: s.dataset, AtlasProtocolVersion: request.Params.AtlasProtocolVersion,
				ContentLength: strconv.FormatInt(length, 10), FixtureDigest: fmt.Sprintf("%x", digest.Sum(nil)),
			},
		}, file: file,
	}, nil
}
