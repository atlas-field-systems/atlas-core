package corerun

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
)

// ErrUnreachable reports that no Core run answered on the private socket. It
// says nothing about whether an earlier request took effect.
var ErrUnreachable = errors.New("core_unreachable")

// Call sends one private request and reads its reply. A transport failure is
// an unknown outcome for state-changing actions; callers recover by
// inspecting Core rather than repeating them blindly.
func Call(ctx context.Context, socket string, request Request) (Reply, error) {
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "unix", socket)
	if err != nil {
		return Reply{}, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		if err := conn.SetDeadline(deadline); err != nil {
			return Reply{}, fmt.Errorf("set private deadline: %w", err)
		}
	}
	encoded, err := encode(request)
	if err != nil {
		return Reply{}, fmt.Errorf("encode private request: %w", err)
	}
	if _, err := conn.Write(encoded); err != nil {
		return Reply{}, fmt.Errorf("send private %s: %w", request.Action, err)
	}
	line, err := bufio.NewReader(io.LimitReader(conn, MaxMessageBytes)).ReadBytes('\n')
	if err != nil {
		return Reply{}, fmt.Errorf("read private %s reply: %w", request.Action, err)
	}
	var reply Reply
	if err := json.Unmarshal(line, &reply); err != nil {
		return Reply{}, fmt.Errorf("decode private %s reply: %w", request.Action, err)
	}
	if !reply.OK {
		if reply.Error == nil {
			return reply, fmt.Errorf("private %s failed without a reason", request.Action)
		}
		return reply, reply.Error
	}
	return reply, nil
}
