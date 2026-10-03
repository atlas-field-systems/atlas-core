// Package httpcontract integrates Protocol structure checks with HTTP bindings.
// Domain authorization and commit decisions remain with their owning modules.
package httpcontract

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net/http"
	"strings"

	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	middleware "github.com/oapi-codegen/nethttp-middleware"
)

// UUID format checking is opt-in in kin-openapi. Match the supported binding
// decoder and Ajv's canonical UUID/URN spelling without normalizing the input.
func init() {
	openapi3.DefineStringFormatValidator("uuid", openapi3.NewCallbackValidator(func(value string) error {
		var identifier protocol.Identifier
		if err := identifier.UnmarshalText([]byte(value)); err != nil {
			return fmt.Errorf("decode UUID representation: %w", err)
		}
		canonical := identifier.String()
		if !strings.EqualFold(value, canonical) && !strings.EqualFold(value, "urn:uuid:"+canonical) {
			return errors.New("UUID representation is not canonical or a UUID URN")
		}
		return nil
	}))
}

// RequestError is also used by generated parameter and strict-decoding hooks.
// Responses intentionally omit rejected inputs because they may contain secrets.
func RequestError(w http.ResponseWriter, r *http.Request, err error) {
	operation := strings.TrimPrefix(r.Pattern, r.Method+" ")
	stage := "binding or JSON decoding"
	var structural *openapi3filter.RequestError
	if errors.As(err, &structural) {
		stage = "schema validation"
		if structural.Input != nil && structural.Input.Route != nil {
			operation = structural.Input.Route.Path
		}
	}
	// Registered patterns contain schema names, never submitted path values.
	message := "Request structure is invalid during " + stage + " for " + r.Method
	if operation != "" {
		message += " " + operation
	}
	WriteError(w, http.StatusBadRequest, "invalid_request", message)
}

// WriteError emits the shared Protocol envelope. The context owner sets the
// Dataset/version headers before dispatching to this adapter.
func WriteError(w http.ResponseWriter, status int, code, message string) {
	var diagnosticID protocol.Identifier
	if _, err := rand.Read(diagnosticID[:]); err != nil {
		panic(fmt.Errorf("allocate HTTP diagnostic ID: %w", err))
	}
	diagnosticID[6] = (diagnosticID[6] & 0x0f) | 0x40
	diagnosticID[8] = (diagnosticID[8] & 0x3f) | 0x80
	var dataset *protocol.Identifier
	if header := w.Header().Get("Atlas-Dataset-ID"); header != "" {
		var identifier protocol.Identifier
		if err := identifier.UnmarshalText([]byte(header)); err != nil {
			log.Print("HTTP error response has invalid Dataset context")
		} else {
			dataset = &identifier
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(protocol.Error{DatasetId: dataset, Error: protocol.ErrorInfo{
		Code: code, Message: message, RequestId: diagnosticID,
	}}); err != nil {
		log.Printf("write HTTP error response: %v", err)
	}
}

// ValidateRequests rejects unsupported structure before a strict handler can
// dispatch effects. Binary-body qualification is introduced by its owning test.
func ValidateRequests(spec *openapi3.T, next http.Handler) http.Handler {
	// The supported decoders consume one JSON value and can ignore trailing
	// bytes. Keep the original bytes and reject an incomplete/multiple-value
	// document before generated decoding can dispatch any effects. Non-JSON
	// bodies pass through without this extra read, including binary streams.
	framed := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
		if err == nil && media == "application/json" && r.Body != nil && r.Body != http.NoBody {
			body, readErr := io.ReadAll(r.Body)
			closeErr := r.Body.Close()
			if readErr != nil || closeErr != nil || len(body) > 0 && !json.Valid(body) {
				RequestError(w, r, errors.New("JSON body must contain one complete document"))
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
		next.ServeHTTP(w, r)
	})
	return middleware.OapiRequestValidatorWithOptions(spec, &middleware.Options{
		Options: openapi3filter.Options{SkipSettingDefaults: true},
		ErrorHandlerWithOpts: func(ctx context.Context, err error, w http.ResponseWriter, r *http.Request, opts middleware.ErrorHandlerOpts) {
			RequestError(w, r, err)
		},
	})(framed)
}
