package httpcontract

import (
	"bytes"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
)

// HTTPEncoding wraps the JSON boundary before schema validation. Each request
// contains exactly one independent gzip member. Both encoded and expanded bytes
// are bounded; transport encoding never changes the facts that a process signs.
func HTTPEncoding(next http.Handler, maxJSONBytes int64) (http.Handler, error) {
	if maxJSONBytes <= 0 {
		return nil, errors.New("HTTP encoding requires a positive JSON byte bound")
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Accept-Encoding", "gzip, identity")
		identityAllowed, gzipAllowed := responseCodings(r.Header.Values("Accept-Encoding"))
		if !identityAllowed {
			// A small or non-JSON result cannot use gzip under S1's savings rule.
			// Refuse before dispatch rather than reject after a write committed.
			w.Header().Add("Vary", "Accept-Encoding")
			w.Header().Set("Content-Length", "0")
			w.WriteHeader(http.StatusNotAcceptable)
			return
		}
		coding := strings.TrimSpace(strings.ToLower(r.Header.Get("Content-Encoding")))
		if coding != "" && coding != "identity" && coding != "gzip" {
			WriteError(w, http.StatusUnsupportedMediaType, "unsupported_encoding", "Request content encoding is unsupported")
			return
		}
		if r.Body != nil && r.Body != http.NoBody {
			encoded, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxJSONBytes))
			err = errors.Join(err, r.Body.Close())
			if err != nil {
				RequestError(w, r, err)
				return
			}
			body := encoded
			if coding == "gzip" {
				body, err = decodeGzip(encoded, maxJSONBytes)
				if err != nil {
					RequestError(w, r, err)
					return
				}
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			r.ContentLength = int64(len(body))
			r.Header.Del("Content-Encoding")
			r.Header.Set("Content-Length", strconv.Itoa(len(body)))
		}
		result := &encodedResponse{header: w.Header().Clone(), maximum: maxJSONBytes}
		next.ServeHTTP(result, r)
		if result.overflow {
			// The domain may already have committed. Closing the connection keeps
			// this an unknown caller outcome instead of fabricating a rejection.
			panic(http.ErrAbortHandler)
		}
		if result.status == 0 {
			result.status = http.StatusOK
		}
		body := result.body.Bytes()
		media, _, _ := mime.ParseMediaType(result.header.Get("Content-Type"))
		if media == "application/json" && result.header.Get("Content-Encoding") == "" && gzipAllowed {
			var compressed bytes.Buffer
			writer := gzip.NewWriter(&compressed)
			_, writeErr := writer.Write(body)
			if err := errors.Join(writeErr, writer.Close()); err != nil {
				panic(http.ErrAbortHandler)
			}
			codedHeaders := result.header.Clone()
			codedHeaders.Set("Content-Encoding", "gzip")
			if completeResponseSize(result.status, codedHeaders, int64(compressed.Len())) < completeResponseSize(result.status, result.header, int64(len(body))) {
				result.header = codedHeaders
				body = compressed.Bytes()
			}
		}
		result.header.Add("Vary", "Accept-Encoding")
		for name := range w.Header() {
			w.Header().Del(name)
		}
		for name, values := range result.header {
			w.Header()[name] = values
		}
		if result.status != http.StatusNoContent && result.status != http.StatusNotModified {
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		}
		w.WriteHeader(result.status)
		if r.Method != http.MethodHead && len(body) != 0 {
			if _, err := w.Write(body); err != nil {
				panic(http.ErrAbortHandler)
			}
		}
	}), nil
}

func decodeGzip(encoded []byte, maximum int64) ([]byte, error) {
	source := bytes.NewReader(encoded)
	reader, err := gzip.NewReader(source)
	if err != nil {
		return nil, fmt.Errorf("decode gzip header: %w", err)
	}
	reader.Multistream(false)
	body, readErr := io.ReadAll(io.LimitReader(reader, maximum+1))
	err = errors.Join(readErr, reader.Close())
	if int64(len(body)) > maximum {
		return nil, &http.MaxBytesError{Limit: maximum}
	}
	if err != nil {
		return nil, fmt.Errorf("decode gzip message: %w", err)
	}
	if source.Len() != 0 {
		return nil, errors.New("gzip request must contain exactly one member without trailing bytes")
	}
	return body, nil
}

func responseCodings(values []string) (identityAllowed, gzipAllowed bool) {
	qualities := make(map[string]float64)
	for _, field := range values {
		for _, item := range strings.Split(field, ",") {
			coding, parameters, _ := strings.Cut(strings.TrimSpace(item), ";")
			quality := float64(1)
			if parameters != "" {
				name, value, ok := strings.Cut(strings.TrimSpace(parameters), "=")
				parsed, err := strconv.ParseFloat(value, 64)
				if !ok || !strings.EqualFold(name, "q") || err != nil || !(parsed >= 0 && parsed <= 1) {
					quality = 0
				} else {
					quality = parsed
				}
			}
			coding = strings.ToLower(coding)
			if previous, exists := qualities[coding]; exists {
				quality = min(previous, quality)
			}
			qualities[coding] = quality
		}
	}
	identity, explicitIdentity := qualities["identity"]
	wildcard, explicitWildcard := qualities["*"]
	if !explicitIdentity {
		identity = 1
		if explicitWildcard && wildcard == 0 {
			identity = 0
		}
	}
	gzip, explicitGzip := qualities["gzip"]
	if !explicitGzip {
		gzip = wildcard
	}
	return identity > 0, gzip > 0
}

func completeResponseSize(status int, headers http.Header, bodyBytes int64) int64 {
	copy := headers.Clone()
	copy.Set("Content-Length", strconv.FormatInt(bodyBytes, 10))
	var prefix bytes.Buffer
	fmt.Fprintf(&prefix, "HTTP/1.1 %d %s\r\n", status, http.StatusText(status))
	// Header.Write writes into a memory buffer, which cannot return a write error.
	_ = copy.Write(&prefix)
	return int64(prefix.Len()+2) + bodyBytes
}

type encodedResponse struct {
	header   http.Header
	status   int
	body     bytes.Buffer
	maximum  int64
	overflow bool
}

func (w *encodedResponse) Header() http.Header { return w.header }

func (w *encodedResponse) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
	}
}

func (w *encodedResponse) Write(body []byte) (int, error) {
	if int64(w.body.Len())+int64(len(body)) > w.maximum {
		w.overflow = true
		return 0, errors.New("response exceeds configured JSON byte bound")
	}
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.body.Write(body)
}
