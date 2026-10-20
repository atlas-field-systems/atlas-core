package atlas

import (
	"encoding/json"
	"reflect"
	"testing"
)

func queueExchange(t *testing.T, name string) exchange {
	t.Helper()
	for _, sample := range readFixture[[]exchange](t, "exchanges.json") {
		if sample.Name == name {
			return sample
		}
	}
	t.Fatalf("missing exchange %s", name)
	return exchange{}
}

func queueCheckedResponse(t *testing.T, sample exchange) []byte {
	t.Helper()
	wire, err := ValidateResponse(sample.Name, exchangeResponse(t, sample), ResponseContext{DatasetID: fixtureDataset}, DefaultLimits())
	if err != nil {
		t.Fatal(err)
	}
	return wire
}

const queueTaskA = "00000000-0000-0000-0000-00000000000a"
const queueTaskB = "00000000-0000-0000-0000-00000000000b"

func TestTaskQueueFreshReaderWorkflow(t *testing.T) {
	limits := DefaultLimits()
	func() {
		for i, id := range []Identifier{queueTaskA, queueTaskB} {
			sample := queueExchange(t, "CreateTask")
			request, err := Decode[CreateTaskRequest]("CreateTaskRequest", sample.Request, limits)
			if err != nil {
				t.Fatal(err)
			}
			request.TaskId, request.RequestId = id, id
			sample.Request, err = Encode("CreateTaskRequest", request, limits)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := ValidateRequest(sample.Name, exchangeRequest(t, sample), fixtureDataset, limits); err != nil {
				t.Fatal(err)
			}
			response, err := Decode[CreateTaskResponse]("CreateTaskResponse", sample.Response, limits)
			if err != nil {
				t.Fatal(err)
			}
			response.Data.Id = id
			response.Data.SubmissionSequence = []PositiveCounter{"1", "2"}[i]
			sample.Response, err = Encode("CreateTaskResponse", response, limits)
			if err != nil {
				t.Fatal(err)
			}
			created, err := Decode[CreateTaskResponse]("CreateTaskResponse", queueCheckedResponse(t, sample), limits)
			if err != nil || created.Data.Id != id || created.Data.SubmissionSequence != []PositiveCounter{"1", "2"}[i] {
				t.Fatal("created Task identity or immutable submission order changed", created, err)
			}
		}
		sample := queueExchange(t, "SetTaskOrder")
		sample.Request = json.RawMessage(`{"request_id":"00000000-0000-0000-0000-000000000004","asset_id":"` + fixtureDataset + `","expected_queue_revision":"3","task_ids":["` + queueTaskB + `","` + queueTaskA + `"]}`)
		if _, err := ValidateRequest(sample.Name, exchangeRequest(t, sample), fixtureDataset, limits); err != nil {
			t.Fatal(err)
		}
		sample.Response = json.RawMessage(`{"dataset_id":"` + fixtureDataset + `","data":{"asset_id":"` + fixtureDataset + `","revision":"4","task_ids":["` + queueTaskB + `","` + queueTaskA + `"],"confirmed_revision":null},"commit_cursor":"queue-reordered"}`)
		queueCheckedResponse(t, sample)
	}()

	var recovered TaskQueue
	bodies := map[Identifier]Task{}
	var bodyOrder []Identifier
	for i, id := range []Identifier{queueTaskA, queueTaskB} {
		sample := queueExchange(t, "GetAssignedTasks")
		envelope := queueFields(t, sample.Response)
		page := queueFields(t, envelope["data"])
		var items []json.RawMessage
		if err := json.Unmarshal(page["items"], &items); err != nil || len(items) != 1 {
			t.Fatal("assigned-work fixture needs one Task", err)
		}
		task := queueFields(t, items[0])
		task["id"] = queueJSON(t, id)
		task["submission_sequence"] = queueJSON(t, []string{"1", "2"}[i])
		page["items"] = queueJSON(t, []json.RawMessage{queueJSON(t, task)})
		page["task_queue"] = json.RawMessage(`{"asset_id":"` + fixtureDataset + `","revision":"4","task_ids":["` + queueTaskB + `","` + queueTaskA + `"],"confirmed_revision":null}`)
		sample.Query = "page_size=1"
		if i == 0 {
			page["next_page_token"] = queueJSON(t, "after-A")
		} else {
			delete(page, "next_page_token")
			sample.Query += "&queue_revision=4&page_token=after-A"
		}
		envelope["data"] = queueJSON(t, page)
		sample.Response = queueJSON(t, envelope)
		checked, err := ValidateRequest(sample.Name, exchangeRequest(t, sample), fixtureDataset, limits)
		if err != nil {
			t.Fatal(err)
		}
		query, err := Decode[AssignedTaskQuery]("AssignedTaskQuery", checked.Query, limits)
		if err != nil || query.PageSize == nil || *query.PageSize != 1 {
			t.Fatal("page_size precondition changed", query, err)
		}
		if i == 1 && (query.QueueRevision == nil || *query.QueueRevision != "4" || query.PageToken == nil || *query.PageToken != "after-A") {
			t.Fatal("queue continuation context changed", query)
		}
		read, err := Decode[GetAssignedTasksResponse]("GetAssignedTasksResponse", queueCheckedResponse(t, sample), limits)
		if err != nil || len(read.Data.Items) != 1 {
			t.Fatal("page_size=1 body was not recoverable", read, err)
		}
		if read.Data.TaskQueue.AssetId != fixtureDataset || read.Data.TaskQueue.Revision != "4" || !read.Data.TaskQueue.ConfirmedRevision.IsNull() || !reflect.DeepEqual(read.Data.TaskQueue.TaskIds, []Identifier{queueTaskB, queueTaskA}) {
			t.Fatal("fresh reader lost complete requested order or captured adoption", read.Data.TaskQueue)
		}
		if i == 0 {
			if read.Data.NextPageToken == nil || *read.Data.NextPageToken != "after-A" {
				t.Fatal("first page lost continuation")
			}
			recovered = read.Data.TaskQueue
		} else if read.Data.NextPageToken != nil || !reflect.DeepEqual(read.Data.TaskQueue, recovered) {
			t.Fatal("last page changed pinned queue metadata", read.Data)
		}
		bodies[read.Data.Items[0].Id] = read.Data.Items[0]
		bodyOrder = append(bodyOrder, read.Data.Items[0].Id)
	}
	if !reflect.DeepEqual(bodyOrder, []Identifier{queueTaskA, queueTaskB}) {
		t.Fatal("Task-body pages did not retain bytewise order", bodyOrder)
	}
	var executionOrder []Identifier
	for _, id := range recovered.TaskIds {
		body, ok := bodies[id]
		if !ok {
			t.Fatalf("requested Task %s missing from pages", id)
		}
		executionOrder = append(executionOrder, body.Id)
	}
	if !reflect.DeepEqual(executionOrder, []Identifier{queueTaskB, queueTaskA}) || bodies[queueTaskB].SubmissionSequence != "2" || bodies[queueTaskA].SubmissionSequence != "1" {
		t.Fatal("requested order confused with submission sequence", executionOrder)
	}
	sample := queueExchange(t, "ConfirmTaskOrder")
	confirmation, err := Decode[ConfirmTaskOrderRequest]("ConfirmTaskOrderRequest", sample.Request, limits)
	if err != nil {
		t.Fatal(err)
	}
	confirmation.Source.AssetId = recovered.AssetId
	confirmation.QueueRevision, confirmation.TaskIds = recovered.Revision, recovered.TaskIds
	sample.Request, err = Encode("ConfirmTaskOrderRequest", confirmation, limits)
	if err != nil {
		t.Fatal(err)
	}
	checked, err := ValidateRequest(sample.Name, exchangeRequest(t, sample), fixtureDataset, limits)
	if err != nil {
		t.Fatal(err)
	}
	confirmed, err := Decode[ConfirmTaskOrderRequest]("ConfirmTaskOrderRequest", checked.JSON, limits)
	if err != nil || confirmed.Source.AssetId != fixtureDataset || confirmed.QueueRevision != "4" || !reflect.DeepEqual(confirmed.TaskIds, []Identifier{queueTaskB, queueTaskA}) {
		t.Fatal("confirmation was not reconstructed solely from fresh queue", confirmed, err)
	}
}

func TestTaskQueueSynchronizationWorkflow(t *testing.T) {
	limits := DefaultLimits()
	base, err := Decode[GetAssetResponse]("GetAssetResponse", queueExchange(t, "GetAsset").Response, limits)
	if err != nil {
		t.Fatal(err)
	}
	asset := base.Data
	asset.Version = "4"
	asset.TaskQueue = TaskQueue{AssetId: fixtureDataset, Revision: "4", TaskIds: []Identifier{queueTaskB, queueTaskA}}
	asset.TaskQueue.ConfirmedRevision.SetNull()
	image, err := Variant[ResourceImage]("Asset", "ResourceImage", asset, limits)
	if err != nil {
		t.Fatal(err)
	}
	sample := queueExchange(t, "ReadSnapshot")
	snapshot, err := Decode[ReadSnapshotResponse]("ReadSnapshotResponse", sample.Response, limits)
	if err != nil {
		t.Fatal(err)
	}
	snapshot.Data.Items = []ResourceImage{image}
	sample.Response, err = Encode("ReadSnapshotResponse", snapshot, limits)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := Decode[ReadSnapshotResponse]("ReadSnapshotResponse", queueCheckedResponse(t, sample), limits)
	if err != nil || len(loaded.Data.Items) != 1 {
		t.Fatal("snapshot image unavailable", loaded, err)
	}
	before, err := loaded.Data.Items[0].AsAsset()
	if err != nil || before.Version != "4" || before.TaskQueue.Revision != "4" || !before.TaskQueue.ConfirmedRevision.IsNull() || !reflect.DeepEqual(before.TaskQueue.TaskIds, []Identifier{queueTaskB, queueTaskA}) {
		t.Fatal("snapshot lost requested order", before, err)
	}
	asset.Version = "5"
	asset.TaskQueue.ConfirmedRevision.Set("4")
	image, err = Variant[ResourceImage]("Asset", "ResourceImage", asset, limits)
	if err != nil {
		t.Fatal(err)
	}
	change, err := Variant[ResourceChange]("UpsertChange", "ResourceChange", UpsertChange{Kind: "upsert", Resource: image}, limits)
	if err != nil {
		t.Fatal(err)
	}
	frame := ChangesFrame{Type: "changes", DatasetId: fixtureDataset, ProtocolVersion: "0.1.0", CoreRunId: fixtureRun, Batch: ChangeBatch{Cursor: "queue-adopted", Changes: []ResourceChange{change}}}
	wire, err := Encode("ChangesFrame", frame, limits)
	if err != nil {
		t.Fatal(err)
	}
	if err := ValidateFrame("server", wire, FrameContext{DatasetID: fixtureDataset, CoreRunID: fixtureRun, Authenticated: true, Subscribed: true}, limits); err != nil {
		t.Fatal(err)
	}
	committed, err := Decode[ChangesFrame]("ChangesFrame", wire, limits)
	if err != nil || committed.Batch.Cursor != "queue-adopted" || len(committed.Batch.Changes) != 1 {
		t.Fatal("adoption-only commit was not complete", committed, err)
	}
	upsert, err := committed.Batch.Changes[0].AsUpsertChange()
	if err != nil {
		t.Fatal(err)
	}
	after, err := upsert.Resource.AsAsset()
	if err != nil || after.Id != fixtureDataset || after.Version != "5" || after.TaskQueue.Revision != "4" || after.TaskQueue.ConfirmedRevision.MustGet() != "4" || !reflect.DeepEqual(after.TaskQueue.TaskIds, []Identifier{queueTaskB, queueTaskA}) {
		t.Fatal("adoption-only commit lost queue identity or revisions", after, err)
	}
}

func TestTaskQueueChangedRefusal(t *testing.T) {
	sample := queueExchange(t, "GetAssignedTasks")
	sample.Status = 409
	sample.Response = json.RawMessage(`{"dataset_id":"` + fixtureDataset + `","error":{"code":"queue_changed","message":"Read the requested queue again","request_id":"` + fixtureRun + `"}}`)
	refusal, err := Decode[Error409]("Error409", queueCheckedResponse(t, sample), DefaultLimits())
	if err != nil || refusal.Error.Code != "queue_changed" {
		t.Fatal("declared queue_changed refusal unavailable", refusal, err)
	}
	sample.Status = 400
	if _, err := ValidateResponse(sample.Name, exchangeResponse(t, sample), ResponseContext{DatasetID: fixtureDataset}, DefaultLimits()); err == nil {
		t.Fatal("queue_changed accepted as 400")
	}
}

func TestTaskQueueEmptyReadWorkflow(t *testing.T) {
	sample := queueExchange(t, "GetAssignedTasks")
	sample.Response = json.RawMessage(`{"dataset_id":"` + fixtureDataset + `","data":{"items":[],"task_queue":{"asset_id":"` + fixtureDataset + `","revision":"7","task_ids":[],"confirmed_revision":null}}}`)
	page, err := Decode[GetAssignedTasksResponse]("GetAssignedTasksResponse", queueCheckedResponse(t, sample), DefaultLimits())
	if err != nil || page.Data.Items == nil || len(page.Data.Items) != 0 || page.Data.TaskQueue.TaskIds == nil || len(page.Data.TaskQueue.TaskIds) != 0 || page.Data.TaskQueue.AssetId != fixtureDataset || page.Data.TaskQueue.Revision != "7" || !page.Data.TaskQueue.ConfirmedRevision.IsNull() {
		t.Fatal("empty page lost complete empty queue", page, err)
	}
	envelope := queueFields(t, sample.Response)
	data := queueFields(t, envelope["data"])
	data["queue_revision"] = json.RawMessage(`"7"`)
	for _, keepQueue := range []bool{true, false} {
		if !keepQueue {
			delete(data, "task_queue")
		}
		envelope["data"] = queueJSON(t, data)
		sample.Response = queueJSON(t, envelope)
		if _, err := ValidateResponse(sample.Name, exchangeResponse(t, sample), ResponseContext{DatasetID: fixtureDataset}, DefaultLimits()); err == nil {
			t.Fatal("legacy queue_revision accepted on assigned-work response")
		}
	}
}

func queueJSON(t *testing.T, value interface{}) json.RawMessage {
	t.Helper()
	wire, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return wire
}

func queueFields(t *testing.T, wire json.RawMessage) map[string]json.RawMessage {
	t.Helper()
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(wire, &fields); err != nil {
		t.Fatal(err)
	}
	return fields
}

func TestTaskQueueProjectionBoundaries(t *testing.T) {
	queue := json.RawMessage(`{"asset_id":"` + fixtureDataset + `","revision":"4","task_ids":[],"confirmed_revision":null}`)
	for _, operation := range []string{"GetAsset", "GetAssignedTasks"} {
		t.Run(operation, func(t *testing.T) {
			sample := queueExchange(t, operation)
			envelope := queueFields(t, sample.Response)
			data := queueFields(t, envelope["data"])
			if operation == "GetAssignedTasks" {
				data["items"] = json.RawMessage(`[]`)
			}
			delete(data, "queue_revision")
			for _, variant := range []string{"complete", "missing queue", "missing confirmation", "duplicate IDs", "case duplicate IDs"} {
				t.Run(variant, func(t *testing.T) {
					data["task_queue"] = queue
					switch variant {
					case "missing queue":
						delete(data, "task_queue")
					case "missing confirmation":
						fields := queueFields(t, queue)
						delete(fields, "confirmed_revision")
						data["task_queue"] = queueJSON(t, fields)
					case "duplicate IDs", "case duplicate IDs":
						fields := queueFields(t, queue)
						second := fixtureDataset
						if variant == "case duplicate IDs" {
							second = "a0b1c2d3-e4f5-4a67-8b90-c1d2e3f4a5b6"
						}
						fields["task_ids"] = queueJSON(t, []string{fixtureDataset, second})
						data["task_queue"] = queueJSON(t, fields)
					}
					envelope["data"] = queueJSON(t, data)
					sample.Response = queueJSON(t, envelope)
					_, err := ValidateResponse(operation, exchangeResponse(t, sample), ResponseContext{DatasetID: fixtureDataset}, DefaultLimits())
					if (err == nil) != (variant == "complete") {
						t.Fatalf("queue projection validation: %v", err)
					}
				})
			}
		})
	}
}
