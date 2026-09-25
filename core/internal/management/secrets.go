package management

import (
	"errors"
	"os"
	"strings"

	"github.com/atlas-field-systems/atlas-core/core/internal/identity"
)

// maxSecretFileBytes comfortably fits one credential and a newline.
const maxSecretFileBytes = 128

// writeSecretFile durably creates a new owner-only file holding one secret.
func writeSecretFile(path, secret string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = file.WriteString(secret + "\n")
	if err == nil {
		err = file.Sync()
	}
	if err = errors.Join(err, file.Close()); err != nil {
		return errors.Join(err, os.Remove(path))
	}
	return nil
}

// readSecretFile reads a secret written by writeSecretFile, refusing files
// that other users could read or that do not hold a well-formed credential.
func readSecretFile(path string, prefix identity.CredentialPrefix) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Mode().Perm() != 0o600 || info.Size() > maxSecretFileBytes {
		return "", errors.New("secret file is not owner-only or has an invalid size")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	secret := strings.TrimSuffix(string(data), "\n")
	if !identity.WellFormed(secret, prefix) {
		return "", errors.New("secret file does not hold a valid credential")
	}
	return secret, nil
}
