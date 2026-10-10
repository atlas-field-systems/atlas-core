// Package api is Core's public HTTP adapter. It authenticates callers, enforces
// the Dataset/version wire boundary and content coding, then translates
// generated strict requests into module operations and their results. Domain
// decisions belong to the owning modules.
package api

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/atlas-field-systems/atlas-core/coreerr"
	"github.com/atlas-field-systems/atlas-core/httpcontract"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/getkin/kin-openapi/routers"
)

type contextKey struct{}

// request is the adapter's per-request context: the authenticated principal,
// original header and body facts, and the request arrival instant with its
// monotonic reading for contact proofs.
type request struct {
	principal       *identity.Principal
	enrollment      *identity.Enrollment
	dataset         string
	protocolVersion string
	raw             []byte
	receivedAt      time.Time
}

func from(ctx context.Context) *request {
	if value, ok := ctx.Value(contextKey{}).(*request); ok {
		return value
	}
	return &request{}
}

// Discovery and documentation routes need no Dataset precondition.
var discoveryRoutes = []string{"/health", "/readiness", "/docs", "/openapi.json"}

func operational(path string) bool { return !slices.Contains(discoveryRoutes, path) }

// Anonymous callers may only open the documentation shell.
func anonymousAllowed(r *http.Request) bool {
	return r.Method == http.MethodGet && r.URL.Path == "/docs"
}

// Enrollment authorization authenticates only discovery and first Enrollment.
func enrollmentAllowed(r *http.Request) bool {
	return (r.Method == http.MethodGet && r.URL.Path == "/health") || (r.Method == http.MethodPost && r.URL.Path == "/entities")
}

func writeRejection(w http.ResponseWriter, rejection *coreerr.Error) {
	httpcontract.WriteErrorDetails(w, rejection.Status, rejection.Code, rejection.Message, rejection.Details)
}

// presentedSecret reads Authorization: Bearer or X-API-Key. Credentials never
// travel in URLs.
func presentedSecret(r *http.Request) (string, bool) {
	if header := r.Header.Get("Authorization"); header != "" {
		scheme, secret, found := strings.Cut(header, " ")
		if found && strings.EqualFold(scheme, "Bearer") && secret != "" {
			return secret, true
		}
		return "", true
	}
	if key := r.Header.Get("X-API-Key"); key != "" {
		return key, true
	}
	return "", false
}

// boundary wraps the generated router with the wire boundary checks, in the
// order an unauthenticated caller learns least: route, authentication,
// Dataset/version context, then content coding and body bounds.
func (s *Server) boundary(next http.Handler, findRoute func(*http.Request) error) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		state := &request{receivedAt: time.Now()}
		if err := findRoute(r); err != nil {
			if errors.Is(err, routers.ErrMethodNotAllowed) {
				httpcontract.WriteError(w, http.StatusMethodNotAllowed, "method_not_allowed", "The route does not support this method")
				return
			}
			httpcontract.WriteError(w, http.StatusNotFound, "not_found", "No such route")
			return
		}
		secret, presented := presentedSecret(r)
		token := r.Header.Get("Atlas-Enrollment")
		switch {
		case presented && token != "":
			httpcontract.WriteError(w, http.StatusUnauthorized, "unauthenticated", "Present one authentication form")
			return
		case presented:
			principal, err := s.identity.Authenticate(r.Context(), secret)
			if err != nil {
				s.writeError(w, r, err)
				return
			}
			state.principal = &principal
		case token != "" && enrollmentAllowed(r):
			enrollment, err := s.identity.VerifyEnrollment(r.Context(), token)
			if err != nil {
				s.writeError(w, r, err)
				return
			}
			state.enrollment = &enrollment
		case !anonymousAllowed(r):
			httpcontract.WriteError(w, http.StatusUnauthorized, "unauthenticated", "A valid credential is required")
			return
		}
		current := s.store.DatasetID()
		if operational(r.URL.Path) {
			version := r.Header.Get("Atlas-Protocol-Version")
			if version == "" {
				httpcontract.WriteError(w, http.StatusBadRequest, "protocol_version_required", "Operational requests carry Atlas-Protocol-Version")
				return
			}
			if !slices.Contains(SupportedProtocolVersions(), version) {
				writeRejection(w, coreerr.Invalid("protocol_unsupported", "The requested Protocol edition is not supported").With("supported_protocol_versions", SupportedProtocolVersions()))
				return
			}
			w.Header().Set("Atlas-Protocol-Version", version)
			state.protocolVersion = version
			dataset := r.Header.Get("Atlas-Dataset-ID")
			if dataset == "" {
				w.Header().Set("Atlas-Dataset-ID", current)
				httpcontract.WriteError(w, http.StatusBadRequest, "dataset_required", "Operational requests carry Atlas-Dataset-ID")
				return
			}
			w.Header().Set("Atlas-Dataset-ID", current)
			if !system.SameIdentifier(dataset, current) {
				writeRejection(w, system.DatasetMismatch(current))
				return
			}
			state.dataset = dataset
		} else if state.principal != nil || state.enrollment != nil {
			w.Header().Set("Atlas-Dataset-ID", current)
		}
		if err := s.decodeBody(w, r, state); err != nil {
			s.writeError(w, r, err)
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), contextKey{}, state)))
	})
}

// decodeBody applies the request content coding with bounded input and
// expanded output, keeping the original decoded bytes for signed facts.
// Multi-member gzip streams are decoded as their concatenation under the same
// output bound.
func (s *Server) decodeBody(w http.ResponseWriter, r *http.Request, state *request) error {
	if r.Body == nil || r.Body == http.NoBody {
		return nil
	}
	limit := s.settings.RequestBodyLimitBytes
	tooLarge := coreerr.New(http.StatusRequestEntityTooLarge, "payload_too_large", fmt.Sprintf("Request body exceeds %d bytes", limit))
	read := func(reader io.Reader) ([]byte, error) {
		body, err := io.ReadAll(io.LimitReader(reader, limit+1))
		if err != nil {
			return nil, err
		}
		if int64(len(body)) > limit {
			return nil, tooLarge
		}
		return body, nil
	}
	encoding := strings.ToLower(strings.TrimSpace(r.Header.Get("Content-Encoding")))
	encoded, err := read(r.Body)
	if err != nil {
		if rejection, ok := coreerr.As(err); ok {
			return rejection
		}
		return coreerr.Invalid("invalid_request", "The request body could not be read")
	}
	body := encoded
	switch encoding {
	case "", "identity":
	case "gzip":
		decoder, err := gzip.NewReader(bytes.NewReader(encoded))
		if err != nil {
			return coreerr.Invalid("invalid_content_encoding", "The gzip request body is malformed")
		}
		body, err = read(decoder)
		if err != nil {
			if rejection, ok := coreerr.As(err); ok {
				return rejection
			}
			return coreerr.Invalid("invalid_content_encoding", "The gzip request body is truncated or corrupt")
		}
	default:
		w.Header().Set("Accept-Encoding", AcceptedRequestEncodings)
		return coreerr.New(http.StatusUnsupportedMediaType, "unsupported_content_encoding", "Supported request content codings: "+AcceptedRequestEncodings)
	}
	r.Header.Del("Content-Encoding")
	r.Header.Set("Content-Length", strconv.Itoa(len(body)))
	r.ContentLength = int64(len(body))
	r.Body = io.NopCloser(bytes.NewReader(body))
	state.raw = body
	return nil
}

// AcceptedRequestEncodings advertises request codings Core decodes.
const AcceptedRequestEncodings = "gzip"

// compressed buffers JSON responses and selects gzip only when the receiver
// accepts it and the complete eligible message, including coding signaling
// and Content-Length framing, is smaller than the direct form.
func compressed(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buffered := &bufferedResponse{header: w.Header(), status: http.StatusOK}
		next.ServeHTTP(buffered, r)
		header := w.Header()
		header.Set("Accept-Encoding", AcceptedRequestEncodings)
		body := buffered.body.Bytes()
		media := strings.ToLower(strings.TrimSpace(strings.Split(header.Get("Content-Type"), ";")[0]))
		eligible := len(body) > 0 && (media == "application/json" || strings.HasSuffix(media, "+json"))
		if eligible {
			header.Add("Vary", "Accept-Encoding")
			if acceptsGzip(r.Header.Values("Accept-Encoding")) {
				if encoded, ok := smallerGzip(body); ok {
					header.Set("Content-Encoding", "gzip")
					body = encoded
				}
			}
		}
		if buffered.status != http.StatusNoContent && buffered.status != http.StatusNotModified {
			header.Set("Content-Length", strconv.Itoa(len(body)))
		}
		w.WriteHeader(buffered.status)
		if _, err := w.Write(body); err != nil {
			log.Printf("write HTTP response: %v", err)
		}
	})
}

// smallerGzip compares complete eligible message sizes. Both forms carry the
// same status line and other headers; they differ in body bytes, the
// Content-Length value and the Content-Encoding field line.
func smallerGzip(body []byte) ([]byte, bool) {
	var encoded bytes.Buffer
	writer := gzip.NewWriter(&encoded)
	if _, err := writer.Write(body); err != nil {
		return nil, false
	}
	if err := writer.Close(); err != nil {
		return nil, false
	}
	return encoded.Bytes(), EncodedMessageSize(encoded.Len(), true) < EncodedMessageSize(len(body), false)
}

// EncodedMessageSize is the eligible size of one JSON message: its body, its
// Content-Length field line and, when coded, its Content-Encoding field line.
func EncodedMessageSize(bodyBytes int, gzipped bool) int {
	size := bodyBytes + len("Content-Length: \r\n") + len(strconv.Itoa(bodyBytes))
	if gzipped {
		size += len("Content-Encoding: gzip\r\n")
	}
	return size
}

// acceptsGzip applies Accept-Encoding qvalues (RFC 9110 section 12.5.3).
func acceptsGzip(values []string) bool {
	accepted := false
	for _, value := range values {
		for _, element := range strings.Split(value, ",") {
			coding, parameters, _ := strings.Cut(strings.TrimSpace(element), ";")
			coding = strings.ToLower(strings.TrimSpace(coding))
			if coding != "gzip" && coding != "*" {
				continue
			}
			quality := 1.0
			if name, value, found := strings.Cut(strings.TrimSpace(parameters), "="); found && strings.EqualFold(strings.TrimSpace(name), "q") {
				if parsed, err := strconv.ParseFloat(strings.TrimSpace(value), 64); err == nil {
					quality = parsed
				}
			}
			if coding == "gzip" {
				return quality > 0
			}
			accepted = quality > 0
		}
	}
	return accepted
}

type bufferedResponse struct {
	header http.Header
	status int
	body   bytes.Buffer
	wrote  bool
}

func (b *bufferedResponse) Header() http.Header { return b.header }

func (b *bufferedResponse) WriteHeader(status int) {
	if !b.wrote {
		b.status, b.wrote = status, true
	}
}

func (b *bufferedResponse) Write(data []byte) (int, error) {
	b.wrote = true
	return b.body.Write(data)
}

// recovered converts a handler panic into an internal error without echoing
// request values.
func recovered(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if failure := recover(); failure != nil {
				log.Printf("HTTP handler panic for %s %s: %v", r.Method, r.URL.Path, failure)
				httpcontract.WriteError(w, http.StatusInternalServerError, "internal_error", "Core could not complete the request")
			}
		}()
		next.ServeHTTP(w, r)
	})
}
