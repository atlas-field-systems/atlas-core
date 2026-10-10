// Package coreerr carries typed public rejections from owning modules to the
// HTTP adapter. A rejection states that Core refused the request without
// effects; any other error is an internal failure.
package coreerr

import (
	"errors"
	"fmt"
	"net/http"
)

// Error is an explicit rejection with a stable Protocol code. Messages and
// details never contain credentials or other secret-bearing request values.
type Error struct {
	Status  int
	Code    string
	Message string
	Details map[string]any
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Code, e.Message) }

// New constructs a rejection.
func New(status int, code, message string) *Error {
	return &Error{Status: status, Code: code, Message: message}
}

// With returns a copy carrying one more safe detail.
func (e *Error) With(key string, value any) *Error {
	details := make(map[string]any, len(e.Details)+1)
	for k, v := range e.Details {
		details[k] = v
	}
	details[key] = value
	return &Error{Status: e.Status, Code: e.Code, Message: e.Message, Details: details}
}

// As reports whether err is a rejection.
func As(err error) (*Error, bool) {
	var rejection *Error
	ok := errors.As(err, &rejection)
	return rejection, ok
}

// Paths attaches the offending JSON Pointer paths.
func (e *Error) Paths(paths ...string) *Error { return e.With("paths", paths) }

// Common rejections. Owning modules choose which applies.
func Invalid(code, message string) *Error   { return New(http.StatusBadRequest, code, message) }
func Forbidden(code, message string) *Error { return New(http.StatusForbidden, code, message) }
func Conflict(code, message string) *Error  { return New(http.StatusConflict, code, message) }
func NotFound(message string) *Error        { return New(http.StatusNotFound, "not_found", message) }
func Gone(code, message string) *Error      { return New(http.StatusGone, code, message) }
func Unauthenticated(code, message string) *Error {
	return New(http.StatusUnauthorized, code, message)
}
