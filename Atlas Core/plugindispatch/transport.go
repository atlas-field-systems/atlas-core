package plugindispatch

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
)

// Framed JSON bounds allocations before decoding. One request receives one
// response; callers own deadlines and connection lifetime.
func (c *Contract) Receive(connection net.Conn, target any) error {
	var length uint32
	if err := binary.Read(connection, binary.BigEndian, &length); err != nil {
		return err
	}
	if length == 0 || uint64(length) > uint64(c.Limits.MessageBytes) {
		return errors.New("payload_too_large")
	}
	body := make([]byte, int(length))
	if _, err := io.ReadFull(connection, body); err != nil {
		return err
	}
	return c.Decode(body, target)
}
func (c *Contract) Send(connection net.Conn, value any) error {
	body, err := c.Encode(value)
	if err != nil {
		return err
	}
	if err := binary.Write(connection, binary.BigEndian, uint32(len(body))); err != nil {
		return err
	}
	_, err = io.Copy(connection, bytes.NewReader(body))
	return err
}
