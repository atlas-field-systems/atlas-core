package main

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// Descriptor exhaustion belongs to the isolated Core fixture process, never
// the test runner or Plugin. Existing command pipes remain usable for recovery.
type descriptorExhaustion struct {
	limit *unix.Rlimit
	files []*os.File
}

func (d *descriptorExhaustion) exhaust() error {
	if d.limit != nil {
		return errors.New("descriptors_already_exhausted")
	}
	var original unix.Rlimit
	if err := unix.Getrlimit(unix.RLIMIT_NOFILE, &original); err != nil {
		return err
	}
	limited := original
	limited.Cur = min(limited.Cur, 128)
	if err := unix.Setrlimit(unix.RLIMIT_NOFILE, &limited); err != nil {
		return err
	}
	d.limit = &original
	for {
		file, err := os.Open(os.DevNull)
		if err != nil {
			if errors.Is(err, unix.EMFILE) {
				return nil
			}
			return errors.Join(err, d.restore())
		}
		d.files = append(d.files, file)
	}
}

func (d *descriptorExhaustion) restore() (result error) {
	for _, file := range d.files {
		result = errors.Join(result, file.Close())
	}
	d.files = nil
	if d.limit != nil {
		result = errors.Join(result, unix.Setrlimit(unix.RLIMIT_NOFILE, d.limit))
		d.limit = nil
	}
	return result
}
