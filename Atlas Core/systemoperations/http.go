package systemoperations

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"github.com/atlas-field-systems/atlas-core/coremaintenance"
	"github.com/atlas-field-systems/atlas-core/entities"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/httpcontract"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/retryidentity"
	"github.com/atlas-field-systems/atlas-core/tasks"
	"github.com/atlas-field-systems/atlas-core/writecommit"
	"github.com/getkin/kin-openapi/openapi3"
	"github.com/google/uuid"
	"io"
	"net/http"
	"strings"
	"time"
)

const ProtocolVersion = "0.1.0"
const ordinaryPageLifetime = 60 * time.Second

type requestContext struct {
	principal                        identity.Principal
	secret, dataset, version, target string
	raw                              []byte
}
type requestKey struct{}

func wire(ctx context.Context) requestContext {
	value, _ := ctx.Value(requestKey{}).(requestContext)
	return value
}

type httpAPI struct {
	core    *Core
	spec    *openapi3.T
	openapi map[string]interface{}
	pager   *pagination
	maximum int64
}

func structuralValidator(schema *openapi3.Schema, max int64) func(interface{}) error {
	return func(value interface{}) error {
		body, err := json.Marshal(value)
		if err != nil {
			return err
		}
		if int64(len(body)) > max {
			return writecommit.ErrLimit
		}
		var document interface{}
		if err = json.Unmarshal(body, &document); err != nil {
			return err
		}
		return schema.VisitJSON(document)
	}
}
func (c *Core) Handler(ctx context.Context) (http.Handler, error) {
	metadata, err := c.boundary.Inspect(ctx)
	if err != nil {
		return nil, err
	}
	if metadata.InstallationID == "" {
		return nil, errors.New("setup_required")
	}
	var config coremaintenance.Config
	if err = json.Unmarshal([]byte(metadata.Configuration), &config); err != nil {
		return nil, err
	}
	c.boundary.SetMaximumJSONBytes(config.MaxJSONBytes)
	spec, err := protocol.GetSwagger()
	if err != nil {
		return nil, err
	}
	spec.Servers = nil
	assetValidator := structuralValidator(spec.Components.Schemas["Asset"].Value, config.MaxJSONBytes)
	taskValidator := structuralValidator(spec.Components.Schemas["Task"].Value, config.MaxJSONBytes)
	c.entities = entities.New(c.boundary, c.identity, entities.Options{CommunicationTime: c.communicationTime, Validate: func(value protocol.Asset) error { return assetValidator(value) }, Freshness: time.Duration(config.ContactFreshnessMS) * time.Millisecond, Degraded: time.Duration(config.DegradedAfterMS) * time.Millisecond, Offline: time.Duration(config.OfflineAfterMS) * time.Millisecond})
	c.tasks = tasks.New(c.boundary, c.entities, c.identity, tasks.Options{Validate: func(value protocol.Task) error { return taskValidator(value) }, MaximumOutstanding: int64(config.MaxOutstandingTasksPerAsset)})
	c.entities.AttachQueues(c.tasks)
	raw, err := json.Marshal(spec)
	if err != nil {
		return nil, err
	}
	var openapi map[string]interface{}
	if err = json.Unmarshal(raw, &openapi); err != nil {
		return nil, err
	}
	var pageKey []byte
	if err = c.boundary.Read(ctx, metadata.DatasetID, func(commit *writecommit.Commit) error {
		var e error
		pageKey, e = c.identity.PageKey(ctx, commit)
		return e
	}); err != nil {
		return nil, err
	}
	pageClock := c.pageTime
	if pageClock == nil {
		pageClock = time.Now
	}
	api := &httpAPI{core: c, spec: spec, openapi: openapi, pager: &pagination{key: pageKey, lifetime: ordinaryPageLifetime, clock: pageClock}, maximum: config.MaxJSONBytes}
	strict := protocol.NewStrictHandlerWithOptions(api, nil, protocol.StrictHTTPServerOptions{RequestErrorHandlerFunc: httpcontract.RequestError, ResponseErrorHandlerFunc: c.error})
	handler := protocol.HandlerWithOptions(strict, protocol.GorillaServerOptions{ErrorHandlerFunc: httpcontract.RequestError})
	// Identity authenticates before structural dispatch, including pending first Enrollment.
	validationSpec := *spec
	validationSpec.Security = nil
	validated, err := httpcontract.ValidateRequests(&validationSpec, handler, config.MaxJSONBytes)
	if err != nil {
		return nil, err
	}
	captured := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		metadata, err := c.boundary.Inspect(r.Context())
		if err != nil {
			c.error(w, r, err)
			return
		}
		w.Header().Set("Atlas-Dataset-ID", metadata.DatasetID)
		w.Header().Set("Atlas-Protocol-Version", ProtocolVersion)
		secret := identity.Secret(r.Header.Get("Authorization"), r.Header.Get("X-API-Key"))
		var principal identity.Principal
		authErr := c.boundary.Read(r.Context(), "", func(commit *writecommit.Commit) error {
			var e error
			principal, e = c.identity.Authenticate(r.Context(), commit, secret)
			return e
		})
		if authErr != nil && !(r.Method == http.MethodPost && r.URL.Path == "/entities" && errors.Is(authErr, identity.ErrUnauthorized)) {
			if r.URL.Path == "/docs" {
				w.Header().Set("Content-Type", "text/html")
				w.WriteHeader(http.StatusUnauthorized)
				io.WriteString(w, `<!doctype html><title>Atlas documentation</title><form><label>API key<input type="password" autocomplete="off"></label><button>Open</button></form><script>document.querySelector('form').onsubmit=async(e)=>{e.preventDefault();const key=document.querySelector('input').value;const response=await fetch('/docs',{headers:{Authorization:'Bearer '+key}});if(response.ok){const html=await response.text();document.open();document.write(html);document.close()}}</script>`)
				return
			}
			c.error(w, r, authErr)
			return
		}
		version := r.Header.Get("Atlas-Protocol-Version")
		discovery := r.URL.Path == "/health" || r.URL.Path == "/readiness" || r.URL.Path == "/docs" || r.URL.Path == "/openapi.json"
		if version == "" && discovery {
			version = ProtocolVersion
		}
		if version != ProtocolVersion {
			c.error(w, r, &publicError{400, "protocol_incompatible", "Requested Protocol edition is unsupported"})
			return
		}
		dataset := r.Header.Get("Atlas-Dataset-ID")
		if !discovery {
			if dataset == "" {
				c.error(w, r, &publicError{400, "dataset_required", "Operational request requires its Dataset identity"})
				return
			}
			parsed, e := uuid.Parse(dataset)
			if e != nil {
				httpcontract.RequestError(w, r, e)
				return
			}
			if parsed.String() != metadata.DatasetID {
				c.error(w, r, writecommit.ErrDataset)
				return
			}
		}
		var body []byte
		if r.Body != nil && r.Body != http.NoBody {
			body, err = io.ReadAll(io.LimitReader(r.Body, config.MaxJSONBytes+1))
			if err != nil {
				httpcontract.RequestError(w, r, err)
				return
			}
			if int64(len(body)) > config.MaxJSONBytes {
				httpcontract.RequestError(w, r, &http.MaxBytesError{Limit: config.MaxJSONBytes})
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
		}
		if r.Method == http.MethodPatch && strings.HasPrefix(r.URL.Path, "/entities/") && len(strings.Split(strings.Trim(r.URL.Path, "/"), "/")) == 2 {
			if err := httpcontract.CheckJSONDocument(body); err != nil {
				httpcontract.RequestError(w, r, err)
				return
			}
			if err := entities.AdmitPatch(body, principal); err != nil {
				c.error(w, r, err)
				return
			}
		}
		if err := componentAdmission(spec, r, body); err != nil {
			c.error(w, r, err)
			return
		}
		if c.beforeDispatch != nil {
			if err = c.beforeDispatch(r.Context(), Dispatch{Method: r.Method, Path: r.URL.Path, DatasetID: dataset, PrincipalID: principal.ID}); err != nil {
				c.error(w, r, err)
				return
			}
		}
		target := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		segments := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(segments) > 1 && (segments[0] == "entities" || segments[0] == "tasks") {
			target = segments[1]
		}
		r = r.WithContext(context.WithValue(r.Context(), requestKey{}, requestContext{principal, secret, dataset, version, target, body}))
		validated.ServeHTTP(w, r)
	})
	encoded, err := httpcontract.HTTPEncoding(captured, config.MaxJSONBytes)
	if err != nil {
		return nil, err
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		metadata, err := c.boundary.Inspect(r.Context())
		if err != nil {
			c.error(w, r, err)
			return
		}
		w.Header().Set("Atlas-Dataset-ID", metadata.DatasetID)
		w.Header().Set("Atlas-Protocol-Version", ProtocolVersion)
		encoded.ServeHTTP(w, r)
	}), nil
}

// Components retain their module error vocabulary while the supported Protocol
// validator supplies the structure and offending paths.
func componentAdmission(spec *openapi3.T, r *http.Request, raw []byte) error {
	if (r.Method != http.MethodPatch && r.Method != http.MethodPost) || !strings.HasPrefix(r.URL.Path, "/entities/") {
		return nil
	}
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil {
		return nil
	}
	name, prefix, body := "ReportedComponents", "/components", fields["components"]
	if strings.HasSuffix(r.URL.Path, "/status") && r.Method == http.MethodPatch {
		name, prefix, body = "StatusReport", "/status", fields["status"]
	}
	if len(body) == 0 {
		return nil
	}
	var value interface{}
	if json.Unmarshal(body, &value) != nil {
		return nil
	}
	err := spec.Components.Schemas[name].Value.VisitJSON(value)
	if err == nil {
		return nil
	}
	var invalid *openapi3.SchemaError
	if errors.As(err, &invalid) {
		for _, part := range invalid.JSONPointer() {
			prefix += "/" + strings.ReplaceAll(strings.ReplaceAll(part, "~", "~0"), "/", "~1")
		}
	}
	return &entities.MutationError{Code: "invalid_component", Paths: []string{prefix}}
}

type publicError struct {
	status        int
	code, message string
}

func (e *publicError) Error() string { return e.code }
func domainError(w http.ResponseWriter, r *http.Request, err error) {
	status, code, message := 500, "internal_error", "Core could not complete the operation"
	var paths []string
	var mutation *entities.MutationError
	var public *publicError
	if errors.As(err, &mutation) {
		status, code, message = 400, mutation.Code, "Submitted fields violate their mutation class"
		paths = mutation.Paths
		if code == "forbidden_field" {
			status = 403
		}
		if code == "invalid_component" {
			status = 422
		}
	} else if errors.As(err, &public) {
		status, code, message = public.status, public.code, public.message
	} else {
		switch {
		case errors.Is(err, writecommit.ErrLimit):
			status, code, message = 429, "resource_limit", "Complete committed result exceeds the supported message bound"
		case errors.Is(err, writecommit.ErrDataset):
			status, code, message = 409, "dataset_mismatch", "Request targets an obsolete Dataset"
		case errors.Is(err, identity.ErrUnauthorized):
			status, code, message = 401, "unauthorized", "Valid caller credential and proof are required"
		case errors.Is(err, identity.ErrRevoked):
			status, code, message = 401, "credential_revoked", "Caller authority has been revoked"
		case errors.Is(err, identity.ErrForbidden):
			status, code, message = 403, "forbidden_field", "Caller cannot author the supplied fields"
		case errors.Is(err, identity.ErrEnrollment):
			status, code, message = 403, "enrollment_refused", "Enrollment authorization does not permit this binding"
		case errors.Is(err, entities.ErrNotFound):
			status, code, message = 404, "not_found", "Resource does not exist"
		case errors.Is(err, entities.ErrReportConflict):
			status, code, message = 409, "report_identity_conflict", "Report identity was used with different original facts"
		case errors.Is(err, entities.ErrEvidence):
			status, code, message = 409, "evidence_identity_conflict", "Retained evidence identity was used with different original facts"
		case errors.Is(err, entities.ErrObsolete):
			status, code, message = 409, "obsolete_process", "Report process authority is no longer current"
		case errors.Is(err, entities.ErrGeneration):
			status, code, message = 409, "generation_conflict", "Expected process generation is no longer current"
		case errors.Is(err, entities.ErrEdit):
			paths = []string{"/expected_edit_revision"}
			status, code, message = 409, "edit_conflict", "Descriptive edit revision is stale"
		case errors.Is(err, entities.ErrAlias):
			paths = []string{"/alias"}
			status, code, message = 409, "alias_conflict", "Alias is already assigned"
		case errors.Is(err, retryidentity.ErrConflict):
			status, code, message = 409, "request_identity_conflict", "Request identity was used with different original facts"
		case errors.Is(err, retryidentity.ErrEnded):
			status, code, message = 409, "result_deleted", "Original request result has been deleted"
		case errors.Is(err, entities.ErrProtected):
			status, code, message = 409, "nonterminal_tasks", "Asset still has unresolved assigned Tasks"
		case errors.Is(err, tasks.ErrTransition):
			status, code, message = 422, "invalid_task_transition", "Task report does not describe a valid lifecycle transition"
		case errors.Is(err, tasks.ErrTerminal):
			status, code, message = 409, "terminal_task", "Task terminal outcome is immutable"
		case errors.Is(err, tasks.ErrUnsupported):
			status, code, message = 422, "unsupported_command", "Asset does not advertise the requested Command and scheduling"
		case errors.Is(err, entities.ErrInvalid):
			status, code, message = 422, "invalid_component", "Reported facts are invalid"
		}
	}
	if len(paths) > 0 {
		details := map[string]interface{}{"paths": paths}
		id := uuid.MustParse(w.Header().Get("Atlas-Dataset-ID"))
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		json.NewEncoder(w).Encode(protocol.Error{DatasetId: &id, Error: protocol.ErrorInfo{Code: code, Message: message, RequestId: uuid.New(), Details: &details}})
		return
	}
	httpcontract.WriteError(w, status, code, message)
}
func (a *httpAPI) dataset(ctx context.Context) uuid.UUID {
	if targeted := wire(ctx).dataset; targeted != "" {
		if id, err := uuid.Parse(targeted); err == nil {
			return id
		}
	}
	metadata, err := a.core.boundary.Inspect(ctx)
	if err != nil {
		return uuid.Nil
	}
	return uuid.MustParse(metadata.DatasetID)
}
func (a *httpAPI) GetEntity(ctx context.Context, r protocol.GetEntityRequestObject) (protocol.GetEntityResponseObject, error) {
	v, readContext, err := a.core.entities.Read(ctx, r.Params.AtlasDatasetID.String(), wire(ctx).principal, r.EntityId.String())
	if err != nil {
		return nil, err
	}
	return protocol.GetEntity200JSONResponse{Body: protocol.AssetResponse{DatasetId: a.dataset(ctx), ReadContext: readContext, Data: v}, Headers: protocol.GetEntity200ResponseHeaders{AtlasDatasetID: a.dataset(ctx), AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) GetEntityByAlias(ctx context.Context, r protocol.GetEntityByAliasRequestObject) (protocol.GetEntityByAliasResponseObject, error) {
	v, readContext, err := a.core.entities.ByAlias(ctx, r.Params.AtlasDatasetID.String(), wire(ctx).principal, r.Alias)
	if err != nil {
		return nil, err
	}
	return protocol.GetEntityByAlias200JSONResponse{Body: protocol.AssetResponse{DatasetId: a.dataset(ctx), ReadContext: readContext, Data: v}, Headers: protocol.GetEntityByAlias200ResponseHeaders{AtlasDatasetID: a.dataset(ctx), AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) RegisterAsset(ctx context.Context, r protocol.RegisterAssetRequestObject) (protocol.RegisterAssetResponseObject, error) {
	w := wire(ctx)
	metadata, err := a.core.boundary.Inspect(ctx)
	if err != nil {
		return nil, err
	}
	var cfg coremaintenance.Config
	if err = json.Unmarshal([]byte(metadata.Configuration), &cfg); err != nil {
		return nil, err
	}
	v, association, cursor, err := a.core.entities.Register(ctx, r.Params.AtlasDatasetID.String(), *r.Body, w.secret, w.raw, cfg.OpenEnrollment)
	if err != nil {
		return nil, err
	}
	return protocol.RegisterAsset201JSONResponse{Body: protocol.RegistrationResponse{DatasetId: a.dataset(ctx), Data: protocol.RegistrationResponseData{Entity: v, Association: association}, CommitCursor: cursor}, Headers: protocol.RegisterAsset201ResponseHeaders{AtlasDatasetID: a.dataset(ctx), AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) DeleteEntity(ctx context.Context, r protocol.DeleteEntityRequestObject) (protocol.DeleteEntityResponseObject, error) {
	_, err := a.core.entities.Delete(ctx, r.Params.AtlasDatasetID.String(), wire(ctx).principal, r.EntityId.String())
	if err != nil {
		return nil, err
	}
	return protocol.DeleteEntity204Response{Headers: protocol.DeleteEntity204ResponseHeaders{AtlasDatasetID: a.dataset(ctx), AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) GetAssetStatus(ctx context.Context, r protocol.GetAssetStatusRequestObject) (protocol.GetAssetStatusResponseObject, error) {
	v, readContext, err := a.core.entities.Read(ctx, r.Params.AtlasDatasetID.String(), wire(ctx).principal, r.EntityId.String())
	if err != nil {
		return nil, err
	}
	return protocol.GetAssetStatus200JSONResponse{Body: protocol.StatusResponse{DatasetId: a.dataset(ctx), ReadContext: readContext, Data: v.Components.Status}, Headers: protocol.GetAssetStatus200ResponseHeaders{AtlasDatasetID: a.dataset(ctx), AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) entityReport(ctx context.Context, id string, kind string, components *protocol.ReportedComponents, manifest *protocol.CommandManifest, context protocol.ReportContext, authority *protocol.AuthorityClaim) (protocol.EntityReportResponse, error) {
	w := wire(ctx)
	value, receipt, association, cursor, err := a.core.entities.Report(ctx, w.principal, entities.Report{DatasetID: uuid.MustParse(w.dataset).String(), DatasetFact: w.dataset, ProtocolVersion: w.version, Kind: kind, TargetID: w.target, Context: context, Raw: w.raw, Authority: authority, Components: components, Manifest: manifest})
	if err != nil {
		return protocol.EntityReportResponse{}, err
	}
	return protocol.EntityReportResponse{DatasetId: a.dataset(ctx), Data: protocol.EntityReportResponseData{Entity: value, Acceptance: receipt, Authority: association}, CommitCursor: cursor}, nil
}
func (a *httpAPI) Checkin(ctx context.Context, r protocol.CheckinRequestObject) (protocol.CheckinResponseObject, error) {
	v, err := a.entityReport(ctx, r.EntityId.String(), "checkin", r.Body.Components, r.Body.CommandManifest, r.Body.ReportContext, r.Body.AuthorityClaim)
	if err != nil {
		return nil, err
	}
	return protocol.Checkin200JSONResponse{Body: v, Headers: protocol.Checkin200ResponseHeaders{AtlasDatasetID: a.dataset(ctx), AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) PatchEntity(ctx context.Context, r protocol.PatchEntityRequestObject) (protocol.PatchEntityResponseObject, error) {
	w := wire(ctx)
	var selector struct {
		Context json.RawMessage `json:"report_context"`
	}
	if err := json.Unmarshal(w.raw, &selector); err != nil {
		return nil, err
	}
	body := protocol.EntityPatchResponse{}
	if len(selector.Context) != 0 {
		report, err := r.Body.AsEntityReportRequest()
		if err != nil {
			return nil, err
		}
		value, err := a.entityReport(ctx, r.EntityId.String(), "entity_report", report.Components, report.CommandManifest, report.ReportContext, nil)
		if err != nil {
			return nil, err
		}
		if err = body.FromEntityReportResponse(value); err != nil {
			return nil, err
		}
	} else {
		edit, err := r.Body.AsDescriptiveEditRequest()
		if err != nil {
			return nil, err
		}
		value, cursor, err := a.core.entities.Edit(ctx, r.Params.AtlasDatasetID.String(), w.principal, r.EntityId.String(), edit)
		if err != nil {
			return nil, err
		}
		if err = body.FromAssetMutationResponse(protocol.AssetMutationResponse{DatasetId: a.dataset(ctx), Data: value, CommitCursor: cursor}); err != nil {
			return nil, err
		}
	}
	return protocol.PatchEntity200JSONResponse{Body: body, Headers: protocol.PatchEntity200ResponseHeaders{AtlasDatasetID: a.dataset(ctx), AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) ReportAssetStatus(ctx context.Context, r protocol.ReportAssetStatusRequestObject) (protocol.ReportAssetStatusResponseObject, error) {
	report, err := a.entityReport(ctx, r.EntityId.String(), "status_report", &protocol.ReportedComponents{Status: &r.Body.Status}, nil, r.Body.ReportContext, nil)
	if err != nil {
		return nil, err
	}
	return protocol.ReportAssetStatus200JSONResponse{Body: protocol.StatusReportResponse{DatasetId: report.DatasetId, CommitCursor: report.CommitCursor, Data: protocol.StatusReportResponseData{Entity: report.Data.Entity, Status: report.Data.Entity.Components.Status, Acceptance: report.Data.Acceptance}}, Headers: protocol.ReportAssetStatus200ResponseHeaders{AtlasDatasetID: a.dataset(ctx), AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) CreateTask(ctx context.Context, r protocol.CreateTaskRequestObject) (protocol.CreateTaskResponseObject, error) {
	w := wire(ctx)
	v, cursor, err := a.core.tasks.Create(ctx, r.Params.AtlasDatasetID.String(), w.principal, *r.Body, w.raw)
	if err != nil {
		return nil, err
	}
	return protocol.CreateTask201JSONResponse{Body: protocol.TaskMutationResponse{DatasetId: a.dataset(ctx), Data: v, CommitCursor: cursor}, Headers: protocol.CreateTask201ResponseHeaders{AtlasDatasetID: a.dataset(ctx), AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) GetTask(ctx context.Context, r protocol.GetTaskRequestObject) (protocol.GetTaskResponseObject, error) {
	v, readContext, err := a.core.tasks.Read(ctx, r.Params.AtlasDatasetID.String(), wire(ctx).principal, r.TaskId.String())
	if err != nil {
		return nil, err
	}
	return protocol.GetTask200JSONResponse{Body: protocol.TaskResponse{DatasetId: a.dataset(ctx), ReadContext: readContext, Data: v}, Headers: protocol.GetTask200ResponseHeaders{AtlasDatasetID: a.dataset(ctx), AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) UpdateTaskStatus(ctx context.Context, r protocol.UpdateTaskStatusRequestObject) (protocol.UpdateTaskStatusResponseObject, error) {
	w := wire(ctx)
	var selector struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(w.raw, &selector); err != nil {
		return nil, err
	}
	body := protocol.TaskStatusResponse{}
	if selector.Kind == "cancellation_request" {
		request, err := r.Body.AsRequestCancellationRequest()
		if err != nil {
			return nil, err
		}
		value, cursor, err := a.core.tasks.Cancel(ctx, r.Params.AtlasDatasetID.String(), w.principal, r.TaskId.String(), request, w.raw)
		if err != nil {
			return nil, err
		}
		if err = body.FromTaskMutationResponse(protocol.TaskMutationResponse{DatasetId: a.dataset(ctx), Data: value, CommitCursor: cursor}); err != nil {
			return nil, err
		}
	} else {
		request, err := r.Body.AsTaskReportRequest()
		if err != nil {
			return nil, err
		}
		value, acceptance, cursor, err := a.core.tasks.Report(ctx, w.principal, r.TaskId.String(), request, entities.Report{DatasetID: r.Params.AtlasDatasetID.String(), DatasetFact: w.dataset, ProtocolVersion: w.version, Kind: "task_report", TargetID: w.target, Context: request.ReportContext, Raw: w.raw})
		if err != nil {
			return nil, err
		}
		if err = body.FromTaskReportResponse(protocol.TaskReportResponse{DatasetId: a.dataset(ctx), Data: protocol.TaskReportResponseData{Task: value, Acceptance: acceptance}, CommitCursor: cursor}); err != nil {
			return nil, err
		}
	}
	return protocol.UpdateTaskStatus200JSONResponse{Body: body, Headers: protocol.UpdateTaskStatus200ResponseHeaders{AtlasDatasetID: a.dataset(ctx), AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) GetHealth(ctx context.Context, r protocol.GetHealthRequestObject) (protocol.GetHealthResponseObject, error) {
	var metadata writecommit.Metadata
	var config coremaintenance.Config
	var count int64
	var challenge *protocol.ContactChallenge
	readContext, err := a.core.identity.Read(ctx, a.core.boundary, "", wire(ctx).principal, func(c *writecommit.Commit) error {
		metadata = c.Metadata
		if err := json.Unmarshal([]byte(metadata.Configuration), &config); err != nil {
			return err
		}
		var err error
		count, err = a.core.identity.OpenCount(ctx, c)
		if err != nil {
			return err
		}
		if r.Params.AssetId != nil || r.Params.ProcessGeneration != nil {
			if r.Params.AssetId == nil || r.Params.ProcessGeneration == nil {
				return entities.ErrInvalid
			}
			value, err := a.core.entities.ChallengeInside(ctx, c, wire(ctx).principal, r.Params.AssetId.String(), *r.Params.ProcessGeneration)
			if err != nil {
				return err
			}
			challenge = &value
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	value := protocol.Health{Live: true, CoreRelease: WritingRelease, SupportedProtocolVersions: []protocol.ProtocolVersion{ProtocolVersion}, ServerTime: time.Now().UTC(), OpenEnrollment: config.OpenEnrollment, OpenEnrolledIdentityCount: int(count), ContactChallenge: challenge}
	id := uuid.MustParse(metadata.DatasetID)
	return protocol.GetHealth200JSONResponse{Body: protocol.HealthResponse{DatasetId: id, ReadContext: readContext, Data: value}, Headers: protocol.GetHealth200ResponseHeaders{AtlasDatasetID: id, AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) discoveryRead(ctx context.Context) (uuid.UUID, protocol.HTTPReadContext, error) {
	var dataset string
	readContext, err := a.core.identity.Read(ctx, a.core.boundary, "", wire(ctx).principal, func(c *writecommit.Commit) error { dataset = c.Metadata.DatasetID; return nil })
	if err != nil {
		return uuid.Nil, readContext, err
	}
	return uuid.MustParse(dataset), readContext, nil
}

func (a *httpAPI) GetReadiness(ctx context.Context, r protocol.GetReadinessRequestObject) (protocol.GetReadinessResponseObject, error) {
	id, readContext, err := a.discoveryRead(ctx)
	if err != nil {
		return nil, err
	}
	return protocol.GetReadiness200JSONResponse{Body: protocol.ReadinessResponse{DatasetId: id, ReadContext: readContext, Data: protocol.Readiness{Ready: a.core.serving.Load(), Checks: protocol.ReadinessChecks{Sqlite: true, Filesystem: true}}}, Headers: protocol.GetReadiness200ResponseHeaders{AtlasDatasetID: id, AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) GetDocs(ctx context.Context, r protocol.GetDocsRequestObject) (protocol.GetDocsResponseObject, error) {
	id, _, err := a.discoveryRead(ctx)
	if err != nil {
		return nil, err
	}
	body := `<!doctype html><title>Atlas S1 API</title><h1>Atlas S1 API</h1><p>Authenticated operational schema.</p><pre id="schema"></pre><script>const key=prompt('API key');if(key)fetch('/openapi.json',{headers:{Authorization:'Bearer '+key}}).then(r=>r.json()).then(s=>document.getElementById('schema').textContent=JSON.stringify(s,null,2));</script>`
	return protocol.GetDocs200TexthtmlResponse{Body: strings.NewReader(body), ContentLength: int64(len(body)), Headers: protocol.GetDocs200ResponseHeaders{AtlasDatasetID: id, AtlasProtocolVersion: ProtocolVersion}}, nil
}
func (a *httpAPI) GetOpenAPI(ctx context.Context, r protocol.GetOpenAPIRequestObject) (protocol.GetOpenAPIResponseObject, error) {
	id, _, err := a.discoveryRead(ctx)
	if err != nil {
		return nil, err
	}
	return protocol.GetOpenAPI200JSONResponse{Body: a.openapi, Headers: protocol.GetOpenAPI200ResponseHeaders{AtlasDatasetID: id, AtlasProtocolVersion: ProtocolVersion}}, nil
}

func (c *Core) error(w http.ResponseWriter, r *http.Request, err error) {
	if metadata, e := c.boundary.Inspect(r.Context()); e == nil {
		w.Header().Set("Atlas-Dataset-ID", metadata.DatasetID)
	}
	domainError(w, r, err)
}
