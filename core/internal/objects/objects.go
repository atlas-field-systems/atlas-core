// Package objects owns private Object file storage.
package objects

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"
)

// Store is the private directory holding Object content.
type Store struct {
	dir string
}

// Open creates the private Object directory if needed.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create private Object storage: %w", err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return nil, fmt.Errorf("protect private Object storage: %w", err)
	}
	return &Store{dir: dir}, nil
}

// Existing refers to Object storage without creating it, for health probes.
func Existing(dir string) *Store { return &Store{dir: dir} }

// Ready proves the directory is writable by creating and removing a probe file.
func (s *Store) Ready() error {
	probe := filepath.Join(s.dir, ".readiness-"+uuid.NewString())
	file, err := os.OpenFile(probe, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	return errors.Join(file.Close(), os.Remove(probe))
}
