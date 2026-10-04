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
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers/gorillamux"
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
// dispatch effects. Binary streams are handled separately.
func ValidateRequests(spec *openapi3.T, next http.Handler, maxJSONBytes int64) (http.Handler, error) {
	if maxJSONBytes <= 0 {
		return nil, errors.New("JSON validation requires a positive body bound")
	}
	router, err := gorillamux.NewRouter(spec)
	if err != nil {
		return nil, fmt.Errorf("create JSON validation router: %w", err)
	}
	validated := middleware.OapiRequestValidatorWithOptions(spec, &middleware.Options{
		Options: openapi3filter.Options{SkipSettingDefaults: true},
		ErrorHandlerWithOpts: func(ctx context.Context, err error, w http.ResponseWriter, r *http.Request, opts middleware.ErrorHandlerOpts) {
			RequestError(w, r, err)
		},
	})(next)
	// Check the original document before either schema or typed decoding. Those
	// decoders can disagree on duplicate names when typed structs merge values.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The supported validator buffers even undeclared media before refusing it.
		// Install the bound before it can read any ordinary request stream.
		if r.Body != nil && r.Body != http.NoBody {
			r.Body = http.MaxBytesReader(w, r.Body, maxJSONBytes)
		}
		// The pinned validator selects its decoder from the base token, even
		// when parameters are malformed. Check that same original JSON stream
		// without changing the header or the validator's media acceptance.
		base, _, _ := strings.Cut(r.Header.Get("Content-Type"), ";")
		media, _, _ := mime.ParseMediaType(base)
		isJSON := media == "application/json" || strings.HasSuffix(media, "+json")
		if isJSON && r.Body != nil && r.Body != http.NoBody {
			body, readErr := io.ReadAll(r.Body)
			closeErr := r.Body.Close()
			bodyErr := errors.Join(readErr, closeErr)
			if bodyErr == nil && len(body) > 0 {
				bodyErr = checkJSONDocument(body)
			}
			if bodyErr != nil {
				// Routing supplies only the authored pattern for diagnostics, never
				// submitted path values. The original failure remains the cause.
				route, parameters, routeErr := router.FindRoute(r)
				if routeErr != nil {
					RequestError(w, r, bodyErr)
				} else {
					RequestError(w, r, &openapi3filter.RequestError{Input: &openapi3filter.RequestValidationInput{
						Request: r, PathParams: parameters, Route: route,
					}, Reason: "JSON document validation failed", Err: bodyErr})
				}
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
		validated.ServeHTTP(w, r)
	}), nil
}

func checkJSONDocument(body []byte) error {
	if err := checkJSONStringEncoding(body); err != nil {
		return err
	}
	if !json.Valid(body) {
		return errors.New("JSON body must contain one complete document")
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.UseNumber()
	if err := readJSONValue(decoder); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return errors.New("JSON body has trailing content")
	}
	return nil
}

func readJSONValue(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, composite := token.(json.Delim)
	if !composite {
		return nil
	}
	switch delimiter {
	case '{':
		names := make(map[string]struct{})
		for decoder.More() {
			token, err := decoder.Token()
			if err != nil {
				return err
			}
			name, ok := token.(string)
			if !ok {
				return errors.New("JSON object name must be a string")
			}
			if _, duplicate := names[name]; duplicate {
				return errors.New("JSON object repeats a member name")
			}
			names[name] = struct{}{}
			if err := readJSONValue(decoder); err != nil {
				return err
			}
		}
	case '[':
		for decoder.More() {
			if err := readJSONValue(decoder); err != nil {
				return err
			}
		}
	default:
		return errors.New("JSON has an unexpected closing delimiter")
	}
	_, err = decoder.Token()
	return err
}

// encoding/json replaces invalid UTF-8 and unpaired escapes with U+FFFD.
// Inspect the wire spelling first so validation never accepts rewritten text.
func checkJSONStringEncoding(body []byte) error {
	if !utf8.Valid(body) {
		return errors.New("JSON text is not valid UTF-8")
	}
	inString := false
	for i := 0; i < len(body); i++ {
		if body[i] == '"' {
			inString = !inString
			continue
		}
		if !inString || body[i] != '\\' {
			continue
		}
		i++
		if i >= len(body) {
			return errors.New("JSON string has an incomplete escape")
		}
		if body[i] != 'u' {
			continue
		}
		unit, err := unicodeEscape(body, i)
		if err != nil {
			return err
		}
		i += 4
		if unit >= 0xdc00 && unit <= 0xdfff {
			return errors.New("JSON string has an unpaired low surrogate")
		}
		if unit >= 0xd800 && unit <= 0xdbff {
			if i+2 >= len(body) || body[i+1] != '\\' || body[i+2] != 'u' {
				return errors.New("JSON string has an unpaired high surrogate")
			}
			low, err := unicodeEscape(body, i+2)
			if err != nil || low < 0xdc00 || low > 0xdfff {
				return errors.New("JSON string has an unpaired high surrogate")
			}
			i += 6
		}
	}
	return nil
}

func unicodeEscape(body []byte, offset int) (uint64, error) {
	if offset+4 >= len(body) {
		return 0, errors.New("JSON string has an incomplete Unicode escape")
	}
	return strconv.ParseUint(string(body[offset+1:offset+5]), 16, 16)
}
