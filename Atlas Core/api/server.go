package api

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	"github.com/atlas-field-systems/atlas-core/coreconfig"
	"github.com/atlas-field-systems/atlas-core/coreerr"
	"github.com/atlas-field-systems/atlas-core/entities"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/httpcontract"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/atlas-field-systems/atlas-core/tasks"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/getkin/kin-openapi/routers/gorillamux"
)

//go:embed docs.html
var docsShell []byte

// Server implements the generated strict server over Core's modules.
type Server struct {
	store    *system.Store
	identity *identity.Module
	entities *entities.Module
	tasks    *tasks.Module
	settings coreconfig.Settings
	spec     *openapi3.T
	document []byte
}

// SupportedProtocolVersions are the Protocol editions this Core release
// implements, taken from the served contract.
func SupportedProtocolVersions() []string {
	spec, err := protocol.GetSwagger()
	if err != nil {
		panic(fmt.Sprintf("embedded Protocol contract is invalid: %v", err))
	}
	return []string{spec.Info.Version}
}

// NewServer prepares the adapter and its served contract.
func NewServer(store *system.Store, identityModule *identity.Module, entityModule *entities.Module, taskModule *tasks.Module, settings coreconfig.Settings) (*Server, error) {
	spec, err := protocol.GetSwagger()
	if err != nil {
		return nil, fmt.Errorf("load embedded Protocol contract: %w", err)
	}
	document, err := spec.MarshalJSON()
	if err != nil {
		return nil, fmt.Errorf("encode served Protocol contract: %w", err)
	}
	return &Server{store: store, identity: identityModule, entities: entityModule, tasks: taskModule, settings: settings, spec: spec, document: document}, nil
}

// Handler assembles the public HTTP boundary.
func (s *Server) Handler() (http.Handler, error) {
	strict := protocol.NewStrictHandlerWithOptions(s, nil, protocol.StrictHTTPServerOptions{
		RequestErrorHandlerFunc:  httpcontract.RequestError,
		ResponseErrorHandlerFunc: s.writeError,
	})
	routes := protocol.HandlerWithOptions(strict, protocol.GorillaServerOptions{ErrorHandlerFunc: httpcontract.RequestError})
	validated, err := httpcontract.ValidateAuthenticatedRequests(s.spec, routes, s.settings.RequestBodyLimitBytes)
	if err != nil {
		return nil, err
	}
	router, err := gorillamux.NewRouter(s.spec)
	if err != nil {
		return nil, fmt.Errorf("create route lookup: %w", err)
	}
	findRoute := func(r *http.Request) error {
		_, _, err := router.FindRoute(r)
		return err
	}
	return recovered(compressed(s.boundary(validated, findRoute))), nil
}

// writeError maps module rejections to the typed envelope; any other failure
// is an internal error whose details stay in the diagnostic log.
func (s *Server) writeError(w http.ResponseWriter, r *http.Request, err error) {
	if rejection, ok := coreerr.As(err); ok {
		writeRejection(w, rejection)
		return
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		httpcontract.WriteError(w, http.StatusServiceUnavailable, "unavailable", "Core stopped before completing the request")
		return
	}
	log.Printf("%s %s failed: %v", r.Method, r.URL.Path, err)
	httpcontract.WriteError(w, http.StatusInternalServerError, "internal_error", "Core could not complete the request")
}

// envelope captures one report's original facts for shared acceptance.
func envelope(ctx context.Context, operation, target string) entities.Envelope {
	state := from(ctx)
	return entities.Envelope{Operation: operation, TargetID: target, ProtocolVersion: state.protocolVersion, Raw: state.raw, ReceivedAt: state.receivedAt}
}

func principal(ctx context.Context) identity.Principal {
	if p := from(ctx).principal; p != nil {
		return *p
	}
	return identity.Principal{}
}

func (s *Server) dataset() protocol.Identifier {
	var id protocol.Identifier
	if err := id.UnmarshalText([]byte(s.store.DatasetID())); err != nil {
		panic(fmt.Sprintf("open Dataset identity is not a UUID: %v", err))
	}
	return id
}

func (s *Server) GetHealth(ctx context.Context, request protocol.GetHealthRequestObject) (protocol.GetHealthResponseObject, error) {
	caller := principal(ctx)
	health := protocol.Health{Status: "ok", CoreRelease: s.store.Release(), SupportedProtocolVersions: SupportedProtocolVersions(), ResponseTime: s.store.Now()}
	if enrollment := from(ctx).enrollment; enrollment != nil {
		id := mustUUID(enrollment.AssetID)
		health.EnrollmentAssetId = &id
	} else {
		health.Principal = &protocol.Actor{PrincipalId: mustUUID(caller.ID), Kind: protocol.PrincipalKind(caller.Kind)}
	}
	params := request.Params
	if (params.ChallengeAssetId == nil) != (params.ChallengeGeneration == nil) {
		return nil, coreerr.Invalid("invalid_request", "A contact challenge names both Asset and generation")
	}
	if params.ChallengeAssetId != nil {
		challenge, err := s.entities.IssueChallenge(ctx, caller, params.ChallengeAssetId.String(), *params.ChallengeGeneration)
		if err != nil {
			return nil, err
		}
		health.ContactChallenge = &challenge
	}
	return protocol.GetHealth200JSONResponse{
		Body:    protocol.HealthResponse{DatasetId: s.dataset(), Data: health},
		Headers: protocol.GetHealth200ResponseHeaders{AtlasDatasetID: s.dataset(), AcceptEncoding: AcceptedRequestEncodings},
	}, nil
}

func (s *Server) GetReadiness(ctx context.Context, _ protocol.GetReadinessRequestObject) (protocol.GetReadinessResponseObject, error) {
	checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	ready := s.store.Ping(checkCtx) == nil
	body := protocol.ReadinessResponse{DatasetId: s.dataset(), Data: protocol.Readiness{Ready: ready, Checks: []protocol.ReadinessCheck{{Name: "sqlite", Ready: ready}}}}
	if !ready {
		return protocol.GetReadiness503JSONResponse{Body: body, Headers: protocol.GetReadiness503ResponseHeaders{AtlasDatasetID: s.dataset()}}, nil
	}
	return protocol.GetReadiness200JSONResponse{Body: body, Headers: protocol.GetReadiness200ResponseHeaders{AtlasDatasetID: s.dataset()}}, nil
}

func (s *Server) GetDocs(ctx context.Context, _ protocol.GetDocsRequestObject) (protocol.GetDocsResponseObject, error) {
	if from(ctx).principal == nil {
		return protocol.GetDocs401TexthtmlResponse{Body: bytes.NewReader(docsShell), ContentLength: int64(len(docsShell))}, nil
	}
	return protocol.GetDocs200TexthtmlResponse{Body: bytes.NewReader(docsShell), ContentLength: int64(len(docsShell))}, nil
}

// rawDocument serves the raw OpenAPI document without the success envelope.
type rawDocument struct {
	body    []byte
	dataset string
	version string
}

func (d rawDocument) VisitGetOpenAPIResponse(w http.ResponseWriter) error {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Atlas-Dataset-ID", d.dataset)
	w.Header().Set("Atlas-Protocol-Version", d.version)
	w.WriteHeader(http.StatusOK)
	_, err := w.Write(d.body)
	return err
}

func (s *Server) GetOpenAPI(context.Context, protocol.GetOpenAPIRequestObject) (protocol.GetOpenAPIResponseObject, error) {
	return rawDocument{body: s.document, dataset: s.store.DatasetID(), version: s.spec.Info.Version}, nil
}

func mustUUID(value string) protocol.Identifier {
	var id protocol.Identifier
	if err := id.UnmarshalText([]byte(value)); err != nil {
		panic(fmt.Sprintf("identifier %q is not a UUID", value))
	}
	return id
}

func (s *Server) headers(ctx context.Context) (protocol.Identifier, string) {
	return s.dataset(), from(ctx).protocolVersion
}
