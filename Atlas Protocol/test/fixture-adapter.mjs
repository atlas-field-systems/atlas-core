function schemas(p) {
  return {
    OrdinaryInteger: p.Integer,
    TypedFloat: p.Float,
    Counter: p.Counter,
    Position: p.Position,
    Integer: p.Integer,
    Timestamp: p.Timestamp,
    Attitude: p.Attitude,
    Gimbal: p.Gimbal,
    BearingMeasurement: p.BearingMeasurement,
    BearingMeasurementInput: p.inputSections.bearing_measurement,
    BearingMeasurementRead: p.readSections.bearing_measurement,
    Asset: p.Asset,
    Observation: p.Observation,
    Track: p.Track,
    NewUuid: p.NewId,
    AssetReport: p.AssetReport,
    ObservationReport: p.ObservationReport,
    CreateObservation: p.exchanges.CreateObservation.request.schema,
    AssetDescription: p.AssetDescription,
    AssetType: p.AssetType,
    Capabilities: p.Capabilities,
    CreateTask: p.CreateTask,
    Geometry: p.Geometry,
    StatusReadResult: p.readSections.status,
    ReportTaskExecution: p.ReportTaskExecution,
    ConfirmTaskOrder: p.ConfirmTaskOrder,
    SynchronizationMessage: p.ServerFrame,
  };
}
function pointer(object, path) {
  return path
    .split('/')
    .slice(1)
    .map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce(
      (value, key) => (value === undefined || value === null ? undefined : value[key]),
      object,
    );
}
export function runFixture(fixture, p) {
  const input = fixture.raw_bytes
    ? new Uint8Array(fixture.raw_bytes)
    : new TextEncoder().encode(fixture.raw_json);
  const boundary =
    fixture.boundary === 'synchronization_message'
      ? 'wss_data'
      : (fixture.boundary ?? 'http_request');
  try {
    if (fixture.scope === 'parsing_budget_only') {
      p.checkJsonBytes(input, boundary);
    } else {
      const schema = schemas(p)[fixture.schema_name];
      if (!schema) return { id: fixture.id, pass: false, actual: 'adapter_missing' };
      const definition = p.contract(schema, boundary);
      const value = p.readJson(definition, input);
      const encoded = new TextDecoder().decode(p.writeJson(definition, value));
      if (fixture.canonical_json !== undefined && encoded !== fixture.canonical_json)
        throw new Error('canonical_json differs');
      if (
        fixture.retained_json !== undefined &&
        JSON.stringify(JSON.parse(encoded)) !== JSON.stringify(JSON.parse(fixture.retained_json))
      )
        throw new Error('retained_json differs');
      for (const [path, expected] of Object.entries(fixture.retained_fields ?? {}))
        if (JSON.stringify(pointer(value, path)) !== JSON.stringify(expected))
          throw new Error(`retained field differs ${path}`);
      for (const path of fixture.absent_fields ?? [])
        if (pointer(value, path) !== undefined) throw new Error(`absent field present ${path}`);
      if (fixture.qualification?.includes('bounded_geometry_work')) {
        try {
          p.readJson(definition, input, { maxGeometryWork: 0 });
        } catch (error) {
          if (error instanceof p.ProtocolError && error.code === 'resource_limit')
            return { id: fixture.id, pass: fixture.expected === 'accept', actual: 'accept' };
          throw error;
        }
        throw new Error('exhausted geometry allowance was accepted');
      }
    }
    return { id: fixture.id, pass: fixture.expected === 'accept', actual: 'accept' };
  } catch (error) {
    const code = error instanceof p.ProtocolError ? error.code : error.message;
    return {
      id: fixture.id,
      pass: fixture.expected === 'reject' && (!fixture.error_code || code === fixture.error_code),
      actual: 'reject',
      code,
    };
  }
}
export function runFixtures(corpus, protocol) {
  return corpus.cases.map((fixture) => runFixture(fixture, protocol));
}
