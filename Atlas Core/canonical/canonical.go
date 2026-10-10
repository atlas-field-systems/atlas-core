// Package canonical builds the RFC 8785 signing inputs shared by Asset
// reports, process-authority claims and enrollment authorizations. It works
// from validated original JSON bytes, never from re-encoded generated values,
// so accepted UUID and date-time spellings remain part of the signed facts.
package canonical

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/gowebpki/jcs"
)

// Domain separators keep a signature for one fact kind from verifying as
// another kind with an identical member layout.
const (
	ReportSignature         = "atlas-report-v1"
	AuthorityClaimSignature = "atlas-authority-claim-v1"
	EnrollmentSignature     = "atlas-enrollment-v1"
)

// Transform returns the RFC 8785 canonical form of one JSON document.
func Transform(document []byte) ([]byte, error) {
	canonical, err := jcs.Transform(document)
	if err != nil {
		return nil, fmt.Errorf("canonicalize JSON facts: %w", err)
	}
	return canonical, nil
}

// Object canonicalizes members whose values are original JSON fragments.
func Object(members map[string]json.RawMessage) ([]byte, error) {
	encoded, err := json.Marshal(members)
	if err != nil {
		return nil, fmt.Errorf("assemble JSON facts: %w", err)
	}
	return Transform(encoded)
}

// Members splits one original JSON object into its member fragments.
func Members(document []byte) (map[string]json.RawMessage, error) {
	var members map[string]json.RawMessage
	decoder := json.NewDecoder(bytes.NewReader(document))
	if err := decoder.Decode(&members); err != nil {
		return nil, fmt.Errorf("decode JSON object members: %w", err)
	}
	if members == nil {
		return nil, errors.New("JSON facts must be an object")
	}
	return members, nil
}

// Without returns a copy of members omitting the named keys.
func Without(members map[string]json.RawMessage, names ...string) map[string]json.RawMessage {
	copied := make(map[string]json.RawMessage, len(members))
	for name, value := range members {
		copied[name] = value
	}
	for _, name := range names {
		delete(copied, name)
	}
	return copied
}

// String encodes a literal string member value.
func String(value string) json.RawMessage {
	encoded, err := json.Marshal(value)
	if err != nil {
		// Marshalling a Go string cannot fail.
		panic(err)
	}
	return encoded
}

// Encode is unpadded base64url, the Protocol encoding for keys and signatures.
func Encode(value []byte) string {
	return base64.RawURLEncoding.EncodeToString(value)
}

// Decode accepts only unpadded base64url.
func Decode(value string) ([]byte, error) {
	return base64.RawURLEncoding.DecodeString(value)
}

// Digest is the unpadded base64url SHA-256 of canonical bytes.
func Digest(canonical []byte) string {
	sum := sha256.Sum256(canonical)
	return Encode(sum[:])
}

// PublicKey decodes an Ed25519 public key.
func PublicKey(encoded string) (ed25519.PublicKey, error) {
	key, err := Decode(encoded)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("Ed25519 public key must be 32 bytes of unpadded base64url")
	}
	return ed25519.PublicKey(key), nil
}

// Verify checks an Ed25519 signature over canonical bytes.
func Verify(publicKey ed25519.PublicKey, canonical []byte, signature string) bool {
	decoded, err := Decode(signature)
	if err != nil || len(decoded) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(publicKey, canonical, decoded)
}
