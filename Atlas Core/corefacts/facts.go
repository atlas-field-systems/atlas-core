// Package corefacts preserves original JSON facts for signatures and retries.
package corefacts

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/atlas-field-systems/atlas-core/httpcontract"
	"github.com/cyberphone/json-canonicalization/go/src/webpki.org/jsoncanonicalizer"
)

func Canonical(body []byte) ([]byte, error) {
	if err := httpcontract.CheckJSONDocument(body); err != nil {
		return nil, err
	}
	return jsoncanonicalizer.Transform(body)
}
func Encode(value interface{}) ([]byte, error) {
	body, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	return Canonical(body)
}
func Digest(body []byte) string {
	sum := sha256.Sum256(body)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
func Verify(publicKey, proof string, facts []byte) error {
	key, err := base64.RawURLEncoding.Strict().DecodeString(publicKey)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return fmt.Errorf("invalid public verification key")
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(proof)
	if err != nil || len(signature) != ed25519.SignatureSize || !ed25519.Verify(key, facts, signature) {
		return fmt.Errorf("invalid process or recovery proof")
	}
	return nil
}
