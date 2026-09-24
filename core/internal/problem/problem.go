// Package problem defines the Protocol-visible failures that modules return.
// The HTTP adapter renders them as the Protocol Error envelope; modules never
// choose HTTP status codes directly.
package problem

// Kind classifies a failure for the transport.
type Kind int

const (
	KindInvalid Kind = iota
	KindUnauthorized
	KindForbidden
	KindNotFound
	KindConflict
	KindGone
	KindTooMany
	KindUnavailable
	KindTooLarge
	KindMethodNotAllowed
)

// Error is a failure whose code and message are part of the Protocol contract.
type Error struct {
	Kind    Kind
	Code    string
	Message string
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }

func Invalid(code, message string) *Error {
	return &Error{Kind: KindInvalid, Code: code, Message: message}
}

func Unauthorized(code, message string) *Error {
	return &Error{Kind: KindUnauthorized, Code: code, Message: message}
}

func Forbidden(code, message string) *Error {
	return &Error{Kind: KindForbidden, Code: code, Message: message}
}

func NotFound(code, message string) *Error {
	return &Error{Kind: KindNotFound, Code: code, Message: message}
}

func Conflict(code, message string) *Error {
	return &Error{Kind: KindConflict, Code: code, Message: message}
}

func Gone(code, message string) *Error {
	return &Error{Kind: KindGone, Code: code, Message: message}
}

func TooMany(code, message string) *Error {
	return &Error{Kind: KindTooMany, Code: code, Message: message}
}

func Unavailable(code, message string) *Error {
	return &Error{Kind: KindUnavailable, Code: code, Message: message}
}
