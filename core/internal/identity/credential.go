package identity

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strings"
)

// credentialSecretBytes is the random entropy in every Atlas credential.
const credentialSecretBytes = 32

// CredentialPrefix names the kind of a credential in its plaintext form so an
// operator can tell keys apart; it grants nothing by itself.
type CredentialPrefix string

const (
	OperatorPrefix   CredentialPrefix = "atlas_"
	EnrollmentPrefix CredentialPrefix = "atlas_enroll_"
	AssetPrefix      CredentialPrefix = "atlas_asset_"
	PluginPrefix     CredentialPrefix = "atlas_plugin_"
	// ManagementPrefix marks the secret local management presents to Core.
	ManagementPrefix CredentialPrefix = "atlas_manage_"
	// DispatchPrefix marks the secret Core presents to a Plugin container.
	DispatchPrefix CredentialPrefix = "atlas_dispatch_"
)

// NewCredential returns a new random credential with the given prefix.
func NewCredential(prefix CredentialPrefix) (string, error) {
	secret := make([]byte, credentialSecretBytes)
	if _, err := rand.Read(secret); err != nil {
		return "", fmt.Errorf("generate credential: %w", err)
	}
	return string(prefix) + base64.RawURLEncoding.EncodeToString(secret), nil
}

// WellFormed reports whether credential has the prefix and full secret length.
func WellFormed(credential string, prefix CredentialPrefix) bool {
	encoded, found := strings.CutPrefix(credential, string(prefix))
	if !found {
		return false
	}
	secret, err := base64.RawURLEncoding.DecodeString(encoded)
	return err == nil && len(secret) == credentialSecretBytes
}

// Verifier is the only form of a credential that Core stores.
func Verifier(credential string) []byte {
	digest := sha256.Sum256([]byte(credential))
	return digest[:]
}
