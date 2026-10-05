package main

import (
	"context"
	"fmt"
	"io"
	"net/http"

	"github.com/atlas-field-systems/atlas-core/tests/contractfixture/generated/contract"
)

// Only test tooling uses this visitor. Operational mutation handlers always
// return their normal generated response objects and never inject faults.
type fixtureResponse struct {
	kind  string
	fault string
	wire  *responseWire
}

// responseWire is one independently authored entry in response-fixtures.json.
type responseWire struct {
	Kind        string            `json:"kind"`
	Fault       string            `json:"fault"`
	Status      int               `json:"status"`
	Body        string            `json:"body"`
	Headers     map[string]string `json:"headers"`
	OmitHeaders []string          `json:"omit_headers"`
}

// fixtureContext has already admitted the Dataset and edition and set the
// echoed context headers; a fixture may override or omit them.
func (r fixtureResponse) write(w http.ResponseWriter) error {
	if r.wire == nil {
		return fmt.Errorf("unknown test-only response fixture %s/%s", r.kind, r.fault)
	}
	for name, value := range r.wire.Headers {
		w.Header().Set(name, value)
	}
	omitLength := false
	for _, name := range r.wire.OmitHeaders {
		w.Header().Del(name)
		if name == "Content-Type" {
			// A nil entry suppresses net/http's automatic content sniffing.
			w.Header()["Content-Type"] = nil
		}
		omitLength = omitLength || name == "Content-Length"
	}
	w.WriteHeader(r.wire.Status)
	if omitLength {
		if err := http.NewResponseController(w).Flush(); err != nil {
			return fmt.Errorf("flush fixture without content length: %w", err)
		}
	}
	if _, err := io.WriteString(w, r.wire.Body); err != nil {
		return fmt.Errorf("write response fixture: %w", err)
	}
	return nil
}

func (s *fixtureServer) responseFixture(kind string, fault *string) fixtureResponse {
	response := fixtureResponse{kind: kind}
	if fault != nil {
		response.fault = *fault
	}
	for i := range s.responses {
		if s.responses[i].Kind == kind && s.responses[i].Fault == response.fault {
			response.wire = &s.responses[i]
			break
		}
	}
	return response
}

func (r fixtureResponse) VisitGetResponseReadResponse(w http.ResponseWriter) error {
	return r.write(w)
}
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
	return s.responseFixture("read", request.Params.Fault), nil
}

func (s *fixtureServer) GetResponseMutation(ctx context.Context, request contract.GetResponseMutationRequestObject) (contract.GetResponseMutationResponseObject, error) {
	return s.responseFixture("mutation", request.Params.Fault), nil
}

func (s *fixtureServer) GetResponseError(ctx context.Context, request contract.GetResponseErrorRequestObject) (contract.GetResponseErrorResponseObject, error) {
	return s.responseFixture("error", request.Params.Fault), nil
}

func (s *fixtureServer) GetResponseOpenapi(ctx context.Context, request contract.GetResponseOpenapiRequestObject) (contract.GetResponseOpenapiResponseObject, error) {
	return s.responseFixture("openapi", request.Params.Fault), nil
}

func (s *fixtureServer) GetResponseEmpty(ctx context.Context, request contract.GetResponseEmptyRequestObject) (contract.GetResponseEmptyResponseObject, error) {
	return s.responseFixture("empty", request.Params.Fault), nil
}

func (s *fixtureServer) GetResponseBinary(ctx context.Context, request contract.GetResponseBinaryRequestObject) (contract.GetResponseBinaryResponseObject, error) {
	return s.responseFixture("binary", request.Params.Fault), nil
}
