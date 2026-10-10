package system

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/atlas-field-systems/atlas-core/coreerr"
)

// PageTokenLifetime is the ordinary page-token lifetime.
const PageTokenLifetime = 60 * time.Second

// PageToken is an opaque continuation bound to its Dataset, resource kind,
// filters (Scope) and page size. Owners add their own pinned facts.
type PageToken struct {
	Kind    string            `json:"k"`
	Dataset string            `json:"d"`
	Scope   string            `json:"s"`
	Limit   int               `json:"l"`
	After   string            `json:"a"`
	Issued  int64             `json:"t"`
	Pinned  map[string]string `json:"p,omitempty"`
}

var (
	errCursorInvalid = coreerr.Invalid("cursor_invalid", "The page token does not belong to this query")
	errCursorExpired = coreerr.Gone("cursor_expired", "The page token has expired; restart the read")
)

// SealToken authenticates a continuation with the installation token key.
func (s *Store) SealToken(token PageToken) (string, error) {
	token.Dataset = s.DatasetID()
	token.Issued = s.Now().UnixMilli()
	payload, err := json.Marshal(token)
	if err != nil {
		return "", fmt.Errorf("encode page token: %w", err)
	}
	mac := hmac.New(sha256.New, s.TokenKey())
	mac.Write(payload)
	return base64.RawURLEncoding.EncodeToString(append(payload, mac.Sum(nil)...)), nil
}

// OpenToken verifies a continuation for the same kind, scope and page size.
func (s *Store) OpenToken(encoded, kind, scope string, limit int) (PageToken, error) {
	var token PageToken
	decoded, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(decoded) <= sha256.Size {
		return token, errCursorInvalid
	}
	payload, signature := decoded[:len(decoded)-sha256.Size], decoded[len(decoded)-sha256.Size:]
	mac := hmac.New(sha256.New, s.TokenKey())
	mac.Write(payload)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return token, errCursorInvalid
	}
	if err := json.Unmarshal(payload, &token); err != nil {
		return token, errCursorInvalid
	}
	if !sameIdentifier(token.Dataset, s.DatasetID()) {
		return token, DatasetMismatch(s.DatasetID())
	}
	if token.Kind != kind || token.Scope != scope || token.Limit != limit {
		return token, errCursorInvalid
	}
	if s.Now().Sub(time.UnixMilli(token.Issued)) > PageTokenLifetime {
		return token, errCursorExpired
	}
	return token, nil
}

// PageChanged rejects a continuation whose pinned aggregate changed.
func PageChanged() *coreerr.Error {
	return coreerr.New(http.StatusConflict, "page_changed", "The pinned queue changed between pages; restart the read")
}
