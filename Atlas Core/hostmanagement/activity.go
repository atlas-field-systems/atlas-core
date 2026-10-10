package hostmanagement

import (
	"bufio"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	"github.com/atlas-field-systems/atlas-core/coremaintenance"
)

func (m *Manager) appendLocal(action action) error {
	path := filepath.Join(m.options.Root, "core", "local-actions.jsonl")
	file, err := os.Open(path)
	if err == nil {
		scanner := bufio.NewScanner(file)
		scanner.Buffer(make([]byte, 4096), 65536)
		entries := 0
		for scanner.Scan() {
			entries++
			if entries > 100000 {
				file.Close()
				return errors.New("local action journal exceeds its bound")
			}
			var entry coremaintenance.LocalAction
			if err := json.Unmarshal(scanner.Bytes(), &entry); err != nil {
				file.Close()
				return errors.New("local action journal is invalid")
			}
			if entry.ActionID == action.ID {
				return file.Close()
			}
		}
		err = errors.Join(scanner.Err(), file.Close())
		if err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	entry := coremaintenance.LocalAction{ActionID: action.ID, Kind: action.Kind, ActorUID: action.Actor.UID, ActorGID: action.Actor.GID, AcceptedAt: action.AcceptedAt.Format(time.RFC3339Nano)}
	data, err := json.Marshal(entry)
	if err != nil {
		return err
	}
	data = append(data, '\n')
	file, err = os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	err = errors.Join(err, file.Close())
	if err != nil {
		return err
	}
	dir, err := os.Open(filepath.Dir(path))
	if err != nil {
		return err
	}
	return errors.Join(dir.Sync(), dir.Close())
}
