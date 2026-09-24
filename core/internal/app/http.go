package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/openapi3filter"
	"github.com/getkin/kin-openapi/routers"
	validator "github.com/oapi-codegen/nethttp-middleware"

	"github.com/atlas-field-systems/atlas-core/core/internal/api"
	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

// maxRequestBytes bounds every request body. Protocol request bodies are small
// JSON documents; Object content will use its own streaming route.
const maxRequestBytes = 64 << 10

// maxCredentialBytes rejects oversized bearer values before hashing them.
const maxCredentialBytes = 128

var (
	errUnauthorized     = problem.Unauthorized("unauthorized", "A valid credential is required.")
	errForbidden        = problem.Forbidden("forbidden", "This credential may not call this operation.")
	errRouteNotFound    = problem.NotFound("not_found", "This route is not available.")
	errMethodNotAllowed = &problem.Error{Kind: problem.KindMethodNotAllowed, Code: "method_not_allowed", Message: "This route does not support the method."}
	errTooLarge         = &problem.Error{Kind: problem.KindTooLarge, Code: "request_too_large", Message: "The request body is too large."}
	errInternal         = problem.Unavailable("internal_error", "The request could not be completed.")
)

// newHandler builds the request pipeline:
// body limit → authentication → Protocol validation and access → generated routes.
func (a *App) newHandler() (http.Handler, error) {
	spec, err := api.GetSwagger()
	if err != nil {
		return nil, err
	}
	strict := api.NewStrictHandlerWithOptions(a, nil, api.StrictHTTPServerOptions{
		RequestErrorHandlerFunc:  func(w http.ResponseWriter, r *http.Request, _ error) { a.writeError(w, r, invalidRequest("")) },
		ResponseErrorHandlerFunc: a.writeError,
	})
	routes := api.HandlerWithOptions(strict, api.StdHTTPServerOptions{
		BaseRouter:       http.NewServeMux(),
		ErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, _ error) { a.writeError(w, r, invalidRequest("")) },
	})
	validate := validator.OapiRequestValidatorWithOptions(spec, &validator.Options{
		Options:              openapi3filter.Options{AuthenticationFunc: authorize},
		ErrorHandlerWithOpts: a.writeValidationError,
		DoNotValidateServers: true,
	})
	return limitBody(a.authenticate(validate(routes))), nil
}

func limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
		next.ServeHTTP(w, r)
	})
}

type callerKey struct{}

// callerFrom returns the authenticated caller of a request.
func callerFrom(ctx context.Context) identity.Caller {
	caller, _ := ctx.Value(callerKey{}).(identity.Caller)
	return caller
}

func (a *App) authenticate(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		credential, ok := bearerCredential(r)
		if !ok {
			a.writeError(w, r, errUnauthorized)
			return
		}
		caller, err := a.identity.Authenticate(r.Context(), credential)
		if err != nil {
			a.writeError(w, r, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), callerKey{}, caller)))
	})
}

func bearerCredential(r *http.Request) (string, bool) {
	scheme, credential, found := strings.Cut(r.Header.Get("Authorization"), " ")
	valid := found && strings.EqualFold(scheme, "Bearer") && credential != "" && len(credential) <= maxCredentialBytes
	return credential, valid
}

// authorize admits a caller whose kind names one of the operation's Protocol
// security schemes.
func authorize(_ context.Context, input *openapi3filter.AuthenticationInput) error {
	if string(callerFrom(input.RequestValidationInput.Request.Context()).Kind) != input.SecuritySchemeName {
		return errForbidden
	}
	return nil
}

func (a *App) writeValidationError(_ context.Context, err error, w http.ResponseWriter, r *http.Request, _ validator.ErrorHandlerOpts) {
	var tooLarge *http.MaxBytesError
	var security *openapi3filter.SecurityRequirementsError
	switch {
	case errors.Is(err, routers.ErrMethodNotAllowed):
		a.writeError(w, r, errMethodNotAllowed)
	case errors.Is(err, routers.ErrPathNotFound):
		a.writeError(w, r, errRouteNotFound)
	case errors.As(err, &tooLarge):
		a.writeError(w, r, errTooLarge)
	case errors.As(err, &security):
		a.writeError(w, r, errForbidden)
	default:
		a.writeError(w, r, invalidRequest(schemaReason(err)))
	}
}

// schemaReason describes a validation failure by field and rule only. It
// never includes the submitted value, which may be a credential.
func schemaReason(err error) string {
	var schemaErr *openapi3.SchemaError
	if errors.As(err, &schemaErr) {
		return "/" + strings.Join(schemaErr.JSONPointer(), "/") + ": " + schemaErr.Reason
	}
	var requestErr *openapi3filter.RequestError
	if errors.As(err, &requestErr) && requestErr.Parameter != nil {
		return requestErr.Parameter.In + " parameter " + requestErr.Parameter.Name + " is invalid"
	}
	return ""
}

func invalidRequest(reason string) *problem.Error {
	message := "The request does not match the Protocol."
	if reason != "" {
		message = "The request does not match the Protocol at " + reason + "."
	}
	return problem.Invalid("invalid_request", message)
}

var statusByKind = map[problem.Kind]int{
	problem.KindInvalid:          http.StatusBadRequest,
	problem.KindUnauthorized:     http.StatusUnauthorized,
	problem.KindForbidden:        http.StatusForbidden,
	problem.KindNotFound:         http.StatusNotFound,
	problem.KindConflict:         http.StatusConflict,
	problem.KindGone:             http.StatusGone,
	problem.KindTooMany:          http.StatusTooManyRequests,
	problem.KindUnavailable:      http.StatusServiceUnavailable,
	problem.KindTooLarge:         http.StatusRequestEntityTooLarge,
	problem.KindMethodNotAllowed: http.StatusMethodNotAllowed,
}

// writeError renders a module's Protocol failure, or logs an unexpected error
// and renders a generic internal failure.
func (a *App) writeError(w http.ResponseWriter, r *http.Request, err error) {
	var failure *problem.Error
	if !errors.As(err, &failure) || failure.Kind == problem.KindUnavailable {
		a.log.ErrorContext(r.Context(), "request failed", "method", r.Method, "path", r.URL.Path, "error", err)
	}
	status := http.StatusInternalServerError
	if failure == nil {
		failure = errInternal
	} else {
		status = statusByKind[failure.Kind]
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(api.Error{Code: failure.Code, Message: failure.Message})
}
