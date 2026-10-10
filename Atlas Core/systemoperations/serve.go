package systemoperations

import (
	"net"
	"net/http"
)

type servingListener struct {
	net.Listener
	core *Core
}

func (l servingListener) Accept() (net.Conn, error) {
	l.core.serving.Store(true)
	return l.Listener.Accept()
}

// ServeTLS becomes ready when its public accept loop is running. Maintenance
// setup and preflight never advertise operational serving.
func (c *Core) ServeTLS(server *http.Server, listener net.Listener) error {
	defer c.serving.Store(false)
	return server.ServeTLS(servingListener{listener, c}, "", "")
}
