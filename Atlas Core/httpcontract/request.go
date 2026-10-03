// Package httpcontract integrates Protocol structure checks with HTTP bindings.
// Domain authorization and commit decisions remain with their owning modules.
package httpcontract

import (
	"context"
	"encoding/json"
	"log"
	"net/http"

	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/getkin/kin-openapi/openapi3"
	middleware "github.com/oapi-codegen/nethttp-middleware"
)

// RequestError is also used by generated parameter and strict-decoding hooks.
// Responses intentionally omit rejected inputs because they may contain secrets.
func RequestError(w http.ResponseWriter, r *http.Request, err error) {
	WriteError(w, http.StatusBadRequest, "invalid_request", "Request structure is invalid")
}

// WriteError emits the shared Protocol envelope. The context owner sets the
// Dataset/version headers before dispatching to this adapter.
func WriteError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(protocol.Error{Error: protocol.ErrorInfo{
		Code: code, Message: message, RequestId: [16]byte{},
	}}); err != nil {
		log.Printf("write HTTP error response: %v", err)
	}
}

// ValidateRequests rejects unsupported structure before a strict handler can
// dispatch effects. Binary-body qualification is introduced by its owning test.
func ValidateRequests(spec *openapi3.T, next http.Handler) http.Handler {
	return middleware.OapiRequestValidatorWithOptions(spec, &middleware.Options{
		ErrorHandlerWithOpts: func(ctx context.Context, err error, w http.ResponseWriter, r *http.Request, opts middleware.ErrorHandlerOpts) {
			RequestError(w, r, err)
		},
	})(next)
}
