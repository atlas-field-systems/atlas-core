package plugins

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/atlas-field-systems/atlas-core/core/internal/plugins/internal/registrydb"
)

// Plugin container contract limits (see protocol/plugin-container.md).
const (
	// containerTimeout bounds each call Core makes to a Plugin container.
	containerTimeout = 5 * time.Second
	// maxContainerResponse bounds what Core reads from a container reply.
	maxContainerResponse = 4 << 10
)

// containerHealth is a Plugin's GET /health reply.
type containerHealth struct {
	ID      string `json:"id"`
	Release string `json:"release"`
}

// refusedError reports a definite refusal: the container answered without
// accepting, so the Operation did not start.
type refusedError struct{ status int }

func (e refusedError) Error() string {
	return fmt.Sprintf("the Plugin refused the request (HTTP %d)", e.status)
}

// containers calls Plugin containers over the container contract.
type containers struct {
	client *http.Client
}

func newContainers() containers {
	return containers{client: &http.Client{Timeout: containerTimeout}}
}

// healthy reports whether the container answers as the installed release.
func (c containers) healthy(ctx context.Context, plugin registrydb.Plugin) bool {
	var health containerHealth
	if err := c.call(ctx, plugin, http.MethodGet, "/health", nil, &health); err != nil {
		return false
	}
	return health.ID == plugin.ID && health.Release == plugin.Release
}

type invocation struct {
	ID         string          `json:"id"`
	Capability string          `json:"capability"`
	Input      json.RawMessage `json:"input"`
}

func (c containers) invoke(ctx context.Context, plugin registrydb.Plugin, operation invocation) error {
	return c.call(ctx, plugin, http.MethodPost, "/operations", operation, nil)
}

func (c containers) cancel(ctx context.Context, plugin registrydb.Plugin, operationID string) error {
	return c.call(ctx, plugin, http.MethodPost, "/operations/"+operationID+"/cancel", nil, nil)
}

func (c containers) quiesce(ctx context.Context, plugin registrydb.Plugin) error {
	return c.call(ctx, plugin, http.MethodPost, "/quiesce", nil, nil)
}

func (c containers) call(ctx context.Context, plugin registrydb.Plugin, method, path string, body, reply any) error {
	request, err := newContainerRequest(ctx, plugin, method, path, body)
	if err != nil {
		return err
	}
	response, err := c.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	limited := io.LimitReader(response.Body, maxContainerResponse)
	if response.StatusCode/100 != 2 {
		return refusedError{status: response.StatusCode}
	}
	if reply == nil {
		return nil
	}
	return json.NewDecoder(limited).Decode(reply)
}

func newContainerRequest(ctx context.Context, plugin registrydb.Plugin, method, path string, body any) (*http.Request, error) {
	var payload io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		payload = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, plugin.Endpoint+path, payload)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+plugin.DispatchSecret)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	return request, nil
}
