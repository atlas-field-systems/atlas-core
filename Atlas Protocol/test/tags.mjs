import { harness } from './harness.mjs';
import * as s from './samples.mjs';

export function runTags(p) {
  const { check, assert, refuses, encode, result } = harness(p);
  const section = {
    state: 'value',
    classification: 'state_until_changed',
    observed_at: null,
    value: { presets: ['simulated'] },
  };
  const report = {
    dataset_id: s.id,
    entity_id: s.assetId,
    origin: s.origin,
    report_id: s.requestId,
    sequence: '1',
    generated_at: null,
    mode: 'current',
    sections: { tags: section },
  };
  const read = {
    ...section,
    evidence: {
      dataset_id: s.id,
      entity_id: s.assetId,
      origin: s.origin,
      report_id: s.requestId,
      sequence: '1',
      section: 'tags',
    },
    time_status: { presets: 'unknown' },
  };
  const request = { request_id: s.requestId, asset_id: s.assetId, report };
  check('Asset tags accepts the independent preset report', () => {
    const parsed = p.readJson(p.exchanges.UpdateAsset.request, encode(request));
    assert(parsed.report.sections.tags.value.presets[0] === 'simulated', 'Preset differs');
  });
  check('Tags payloads are closed and unique', () => {
    for (const presets of [[], ['simulated']])
      assert(p.Tags.safeParse({ presets }).success, 'Valid preset set refused');
    assert(p.TagPreset.parse('simulated') === 'simulated', 'Preset export differs');
    for (const value of [
      {},
      null,
      { presets: null },
      { presets: ['unknown'] },
      { presets: ['simulated', 'simulated'] },
      { presets: [], extra: true },
    ])
      assert(!p.Tags.safeParse(value).success, 'Invalid Tags accepted');
  });
  check('Tags section times and results use the normal envelope', () => {
    for (const classification of ['state_until_changed', 'dated_measurement']) {
      assert(
        p.inputSections.tags.safeParse({ ...section, classification }).success,
        'Classification refused',
      );
      assert(p.readSections.tags.safeParse({ ...read, classification }).success, 'Read refused');
    }
    const timed = { ...read, observed_at: s.time, source_times: { presets: null } };
    assert(p.readSections.tags.safeParse(timed).success, 'Explicit unknown source time refused');
    assert(
      p.readSections.tags.safeParse({
        ...timed,
        source_times: { presets: s.time },
        time_status: { presets: 'known' },
      }).success,
      'Known source time refused',
    );
    for (const invalid of [
      { ...read, evidence: null },
      { ...read, time_status: {} },
      { ...read, time_status: { presets: 'known' } },
      { ...read, time_status: { presets: 'unknown', extra: 'unknown' } },
      { ...read, source_times: { extra: null } },
      { ...read, source_times: { presets: null, extra: null } },
    ])
      assert(!p.readSections.tags.safeParse(invalid).success, 'Invalid read metadata accepted');
    assert(!p.inputSections.tags.safeParse(read).success, 'Read metadata accepted on input');
    for (const state of ['error', 'withdrawn']) {
      const failure = {
        state,
        classification: 'state_until_changed',
        observed_at: null,
        ...(state === 'error' ? { error: { code: 'unavailable' } } : {}),
      };
      assert(p.inputSections.tags.safeParse(failure).success, 'Failure input refused');
      assert(
        p.readSections.tags.safeParse({
          ...failure,
          evidence: read.evidence,
          time_status: 'unknown',
        }).success,
        'Failure read refused',
      );
    }
  });
  check('Tags only composes with sourced Asset reports and reads', () => {
    assert(p.Asset.safeParse({ ...s.asset, tags: read }).success, 'Asset Tags refused');
    for (const evidence of [
      { ...read.evidence, entity_id: s.id },
      { ...read.evidence, dataset_id: s.requestId },
      { ...read.evidence, section: 'status' },
      { ...read.evidence, origin: { kind: 'publisher', publisher_id: s.processId } },
    ])
      assert(
        !p.Asset.safeParse({ ...s.asset, tags: { ...read, evidence } }).success,
        'Wrong scope accepted',
      );
    const status = {
      ...s.asset.status,
      evidence: { ...read.evidence, section: 'status', sequence: '2' },
    };
    assert(
      !p.Asset.safeParse({ ...s.asset, tags: read, status }).success,
      'Conflicting report sequences accepted',
    );
    for (const [schema, image] of [
      [p.Observation, s.observation],
      [p.Track, s.track],
      [p.Geofeature, s.geofeature],
    ])
      assert(
        !schema.safeParse({ ...image, tags: read }).success,
        'Unsupported Entity Tags accepted',
      );
    refuses(() =>
      p.readJson(p.exchanges.UpdateAsset.request, encode({ ...request, tags: section })),
    );
    refuses(() =>
      p.readJson(
        p.exchanges.UpdateAsset.request,
        encode({
          ...request,
          report: { ...report, origin: { kind: 'publisher', publisher_id: s.processId } },
        }),
      ),
    );
    refuses(() =>
      p.readJson(
        p.exchanges.RegisterAsset.request,
        encode({ ...s.examples.RegisterAsset[0], tags: section }),
      ),
    );
    assert(
      !p.ObservationReport.safeParse({
        ...report,
        entity_id: s.observationId,
        origin: { kind: 'publisher', publisher_id: s.processId },
      }).success,
      'Observation report Tags accepted',
    );
  });
  return result();
}
