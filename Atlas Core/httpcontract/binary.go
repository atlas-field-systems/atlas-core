package httpcontract

import (
	"errors"
	"fmt"
	"mime"
	"net/http"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers/gorillamux"
)

// ValidateBinaryRequests keeps structural parameter and media validation for one
// explicit binary operation while leaving its bounded body as a stream. Other
// operations keep the ordinary request validator. The handler must translate
// MaxBytesError into its declared JSON rejection and clean failed attempts.
func ValidateBinaryRequests(spec *openapi3.T, next http.Handler, operationID string, maxBytes int64) (http.Handler, error) {
	if operationID == "" || maxBytes <= 0 {
		return nil, errors.New("binary validation requires an operation and positive body bound")
	}
	found := false
	for _, item := range spec.Paths.Map() {
		for _, operation := range item.Operations() {
			if operation.OperationID != operationID {
				continue
			}
			if found || operation.RequestBody == nil || operation.RequestBody.Value == nil || len(operation.RequestBody.Value.Content) == 0 {
				return nil, errors.New("binary validation requires one operation with declared binary content")
			}
			for _, media := range operation.RequestBody.Value.Content {
				if media.Schema == nil || media.Schema.Value == nil || !media.Schema.Value.Type.Is("string") || media.Schema.Value.Format != "binary" {
					return nil, errors.New("binary validation requires a binary schema for each declared media type")
				}
			}
			found = true
		}
	}
	if !found {
		return nil, fmt.Errorf("binary validation operation %q is absent", operationID)
	}
	router, err := gorillamux.NewRouter(spec)
	if err != nil {
		return nil, fmt.Errorf("create binary validation router: %w", err)
	}
	ordinary := ValidateRequests(spec, next)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		route, parameters, err := router.FindRoute(r)
		if err != nil || route.Operation.OperationID != operationID {
			ordinary.ServeHTTP(w, r)
			return
		}
		input := &openapi3filter.RequestValidationInput{
			Request: r, PathParams: parameters, Route: route,
			Options: &openapi3filter.Options{ExcludeRequestBody: true, SkipSettingDefaults: true},
		}
		if err := openapi3filter.ValidateRequest(r.Context(), input); err != nil {
			RequestError(w, r, err)
			return
		}
		media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err != nil || route.Operation.RequestBody.Value.Content[media] == nil {
			WriteError(w, http.StatusUnsupportedMediaType, "unsupported_media_type", "Binary request media type is undeclared for "+r.Method+" "+route.Path)
			return
		}
		if route.Operation.RequestBody.Value.Required && (r.Body == nil || r.Body == http.NoBody) {
			RequestError(w, r, &openapi3filter.RequestError{Input: input, Reason: "binary body is required"})
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, maxBytes)
		next.ServeHTTP(w, r)
	}), nil
}
