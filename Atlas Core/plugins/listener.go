package plugins

import (
	"errors"
	"fmt"
	"net"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

// The persistent lock inode gives cooperating processes one socket owner.
// It is never unlinked: replacing it could grant two independent file locks.
// Close-on-exec prevents child processes from retaining the lifetime claim.
type ownedListener struct {
	*net.UnixListener
	lock     *os.File
	path     string
	identity os.FileInfo
}

func listenOwned(path string) (_ *ownedListener, result error) {
	fd, err := unix.Open(path+".lock", unix.O_CREAT|unix.O_RDWR|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open Plugin socket ownership: %w", err)
	}
	lock := os.NewFile(uintptr(fd), path+".lock")
	defer func() {
		if result != nil {
			result = errors.Join(result, lock.Close())
		}
	}()
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return nil, err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Uid != uint32(os.Geteuid()) || stat.Mode&0o077 != 0 {
		return nil, errors.New("unsafe Plugin socket ownership file")
	}
	if err := unix.Flock(fd, unix.LOCK_EX|unix.LOCK_NB); err != nil {
		return nil, fmt.Errorf("claim Plugin socket ownership: %w", err)
	}
	prior, err := os.Lstat(path)
	if err == nil {
		if prior.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("Plugin socket path contains an unrelated entry")
		}
		// A live listener from an older/nonparticipating owner may not use our
		// lock. Only ECONNREFUSED proves a stale entry; all ambiguity refuses.
		connection, probeErr := net.DialTimeout("unix", path, 250*time.Millisecond)
		if probeErr == nil {
			return nil, errors.Join(errors.New("Plugin socket already live"), connection.Close())
		}
		if !errors.Is(probeErr, unix.ECONNREFUSED) {
			return nil, fmt.Errorf("inspect existing Plugin socket: %w", probeErr)
		}
		current, err := os.Lstat(path)
		if err != nil || !os.SameFile(prior, current) {
			return nil, errors.Join(errors.New("Plugin socket ownership changed"), err)
		}
		if err := os.Remove(path); err != nil {
			return nil, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		return nil, err
	}
	listener.SetUnlinkOnClose(false)
	identity, err := os.Lstat(path)
	if err == nil {
		err = os.Chmod(path, 0o600)
	}
	if err != nil {
		return nil, errors.Join(err, listener.Close())
	}
	return &ownedListener{UnixListener: listener, lock: lock, path: path, identity: identity}, nil
}

// release runs only after the Server has joined every accepted writer. Crash
// releases the kernel lock, leaving its socket entry for the next owner.
func (l *ownedListener) release() error {
	current, err := os.Lstat(l.path)
	if err == nil {
		if !os.SameFile(l.identity, current) {
			err = errors.New("Plugin socket ownership changed before cleanup")
		} else {
			err = os.Remove(l.path)
		}
	} else if errors.Is(err, os.ErrNotExist) {
		err = nil
	}
	return errors.Join(err, l.lock.Close())
}
