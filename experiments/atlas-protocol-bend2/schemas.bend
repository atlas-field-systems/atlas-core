import Base
import ./common.bend as C
import ./shapes.bend as S
import ./domain-schema-components.bend as Components
import ./domain-schema-reports.bend as Reports
import ./domain-schema-tasks.bend as Tasks
import ./domain-schema-resources.bend as Resources
import ./domain-schema-sync.bend as Sync

def definitions() -> List<&2, C.Member>:
  S.members(Components.definitions(), S.members(Reports.definitions(), S.members(Tasks.definitions(), S.members(Resources.definitions(), Sync.definitions()))))

def schema(name: String) -> C.Json:
  C.lookup(definitions(), name)

def names() -> List<&2, String>:
  S.keys(definitions())

def public_names() -> List<&2, String>:
  ["Uuid", "NewId", "Opaque", "Alias", "Counter", "Sequence", "Secret", "Timestamp",
   "Float", "Integer", "PageSize", "Latitude", "Longitude", "Time", "Position", "Altitude",
   "Point", "LineString", "Polygon", "Geometry",
   "Description", "AssetDescription", "AssetType", "SubjectKind", "SubjectType", "GeofeatureKind", "GeofeatureType",
   "Status", "Telemetry", "Attitude", "Gimbal", "Camera", "CameraOptics", "Capacity", "Health", "Heartbeat", "Reserve", "Power", "PowerTimes",
   "Command", "CreateTask", "Capabilities",
   "AssetOrigin", "PublisherOrigin", "Origin", "Constituent", "Constituents", "SectionName", "SectionEvidence", "SectionError", "EvidenceDisposition", "AssetReport", "ObservationReport",
   "ExecutionState", "NonterminalState", "ResultDeclaration", "ResultDeclarations", "TaskQueue", "TaskControl", "ExecutionPayload", "ExecutionEvidence", "ReportTaskExecution", "ReportTaskResults", "QueueConfirmation", "ConfirmTaskOrder", "Task",
   "PublisherSubject", "Communications", "TrackSource", "Asset", "Observation", "Track", "Geofeature",
   "ContentType", "Sha256", "ObjectLength", "Association", "Associations", "ObjectMetadata", "UploadDescriptor", "ObjectEdits", "ContentDescriptor", "ObjectImage",
   "Operator", "ApiKey", "ResourceUsage", "Activity", "MessageLimits", "NegotiatedLimits", "TemporaryLimits", "HealthData", "Readiness",
   "TimeStatus", "HistoryReading", "HistoryFirst", "Continuation", "HistoryQuery", "HistoryPage", "Release", "Released",
   "ErrorObject", "HttpError",
   "ResourceKind", "Put", "Delete", "Change", "Changes", "ReadSnapshot", "SnapshotPage", "ReplayBatch", "ReplayProgress", "ReplayMessage", "ReadChanges", "ReplayPage", "SubscribeChanges", "UnsubscribeChanges", "Subscribed", "Unsubscribed", "Authenticate", "ClientFrame", "ServerFrame",
   "AssignedTasks", "BeginAssetContact", "ContactChallenge", "ReplaceAssetProcess"]

def section_names() -> List<&2, String>:
  Reports.section_names()
