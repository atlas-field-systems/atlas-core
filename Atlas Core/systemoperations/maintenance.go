package systemoperations

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/atlas-field-systems/atlas-core/coremaintenance"
	"github.com/atlas-field-systems/atlas-core/httpcontract"
	"golang.org/x/sys/unix"
	"io"
	"net"
	"net/http"
	"os"
	"time"
)

type peer struct {
	uid, gid uint32
	valid    bool
}
type peerKey struct{}
type MaintenanceServer struct {
	HTTP     *http.Server
	Listener net.Listener
}

func (c *Core) Maintenance(socket string, ownerUID int, ownerGID int, stop func()) (*MaintenanceServer, error) {
	if ownerUID < 0 {
		return nil, errors.New("maintenance owner UID is required")
	}
	if info, err := os.Lstat(socket); err == nil {
		if info.Mode()&os.ModeSocket == 0 {
			return nil, errors.New("maintenance path is not a socket")
		}
		return nil, errors.New("maintenance socket already exists")
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		return nil, err
	}
	mode := os.FileMode(0600)
	if ownerGID >= 0 {
		mode = 0660
	}
	if err = os.Chmod(socket, mode); err != nil {
		listener.Close()
		return nil, err
	}
	if err = os.Chown(socket, ownerUID, ownerGID); err != nil {
		listener.Close()
		return nil, err
	}
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		credential, _ := r.Context().Value(peerKey{}).(peer)
		if !credential.valid || int(credential.uid) != ownerUID && (ownerGID < 0 || int(credential.gid) != ownerGID) {
			w.WriteHeader(403)
			json.NewEncoder(w).Encode(coremaintenance.Error{Code: "management_forbidden", Message: "Unix peer is not an installation owner"})
			return
		}
		if r.Method != http.MethodPost || r.URL.Path != "/maintenance" {
			w.WriteHeader(404)
			json.NewEncoder(w).Encode(coremaintenance.Error{Code: "not_found", Message: "Private method does not exist"})
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1048576))
		if err == nil {
			err = httpcontract.CheckJSONDocument(body)
		}
		var request coremaintenance.Request
		if err == nil {
			decoder := json.NewDecoder(bytes.NewReader(body))
			decoder.DisallowUnknownFields()
			err = decoder.Decode(&request)
		}
		if err != nil {
			w.WriteHeader(400)
			json.NewEncoder(w).Encode(coremaintenance.Error{Code: "invalid_request", Message: "Private request is invalid"})
			return
		}
		result, err := c.Maintain(r.Context(), request)
		if err != nil {
			code := err.Error()
			var typed *coremaintenance.Error
			if errors.As(err, &typed) {
				code = typed.Code
			}
			w.WriteHeader(409)
			json.NewEncoder(w).Encode(coremaintenance.Error{Code: code, Message: "Core refused private operation"})
			return
		}
		if err = json.NewEncoder(w).Encode(result); err != nil {
			return
		}
		if request.Kind == "stop" && stop != nil {
			stop()
		}
	})
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, ConnContext: func(ctx context.Context, conn net.Conn) context.Context {
		credential := peer{}
		unixConn, ok := conn.(*net.UnixConn)
		if !ok {
			return context.WithValue(ctx, peerKey{}, credential)
		}
		raw, err := unixConn.SyscallConn()
		if err != nil {
			return context.WithValue(ctx, peerKey{}, credential)
		}
		var controlErr error
		if err = raw.Control(func(fd uintptr) {
			value, e := unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
			controlErr = e
			if e == nil {
				credential = peer{value.Uid, value.Gid, true}
			}
		}); err != nil || controlErr != nil {
			return context.WithValue(ctx, peerKey{}, peer{})
		}
		return context.WithValue(ctx, peerKey{}, credential)
	}}
	return &MaintenanceServer{server, listener}, nil
}
func (m *MaintenanceServer) Serve() error {
	err := m.HTTP.Serve(m.Listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return fmt.Errorf("private Core listener: %w", err)
}
