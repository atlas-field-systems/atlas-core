import json
import math
import datetime
import os
from pathlib import Path
import re
import sys


def validate(record):
    if not isinstance(record, dict):
        raise ValueError('Record object required')
    required = {'scenario', 'at', 'source', 'inputs', 'checks', 'cleanup', 'verdict', 'failures', 'measurements', 'environment'}
    if not required <= record.keys() or record.keys() - required - {'versions'}:
        raise ValueError('Record fields')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', record['scenario']):
        raise ValueError('Scenario name')
    if not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z', record['at']):
        raise ValueError('Record time')
    datetime.datetime.fromisoformat(record['at'].replace('Z', '+00:00'))
    source = record['source']
    if set(source) != {'branch', 'commit', 'dirty'} or not re.fullmatch('[a-f0-9]{40}', source['commit']) or type(source['dirty']) is not bool:
        raise ValueError('Source')
    if not isinstance(source['branch'], str) or len(source['branch']) > 256 or any(ord(c) < 32 for c in source['branch']):
        raise ValueError('Branch')
    if os.environ.get('EXPECTED_COMMIT') and source['commit'] != os.environ['EXPECTED_COMMIT']:
        raise ValueError('Unexpected source commit')
    if not {'scenario', 'settings'} <= record['inputs'].keys() or record['inputs'].keys() - {'scenario', 'settings', 'actualSettings', 'appliedSettings'} or any(not re.fullmatch('[a-f0-9]{64}', v) for k, v in record['inputs'].items() if k != 'appliedSettings'):
        raise ValueError('Input hashes')
    if 'appliedSettings' in record['inputs'] and (not isinstance(record['inputs']['appliedSettings'], list) or len(record['inputs']['appliedSettings']) > 100 or any(not isinstance(v, str) or not re.fullmatch('[a-f0-9]{64}', v) for v in record['inputs']['appliedSettings'])):
        raise ValueError('Applied Settings hashes')
    if set(record['checks']) != {'tasks', 'order', 'assets', 'positions', 'final_position', 'tracks', 'tags', 'faults'}:
        raise ValueError('Checks missing')
    for check in record['checks'].values():
        kind = check.get('kind')
        if kind == 'passed' and set(check) == {'kind'}:
            continue
        if kind == 'failed' and set(check) == {'kind', 'reasons'} and isinstance(check['reasons'], list) and 1 <= len(check['reasons']) <= 100 and all(isinstance(r, str) and len(r) <= 1024 for r in check['reasons']):
            continue
        if kind == 'unrun' and set(check) == {'kind', 'reason'} and isinstance(check['reason'], str) and len(check['reason']) <= 1024:
            continue
        raise ValueError('Check result')
    cleanup = record['cleanup']
    if set(cleanup) != {'writersDrained', 'createdKeysRevoked', 'clientsClosed', 'coreExit', 'failures'} or any(type(cleanup[k]) is not bool for k in ['writersDrained', 'createdKeysRevoked', 'clientsClosed']) or cleanup['coreExit'] not in ['verified', 'unverified', 'not-owned']:
        raise ValueError('Cleanup')
    for failures in [cleanup['failures'], record['failures']]:
        if not isinstance(failures, list) or len(failures) > 100 or any(not isinstance(f, str) or len(f) > 1024 for f in failures):
            raise ValueError('Failure list')
    if record['verdict'] not in ['passed', 'failed']:
        raise ValueError('Verdict')
    if record['verdict'] == 'passed' and (record['failures'] or cleanup['failures'] or cleanup['coreExit'] == 'unverified' or any(not cleanup[k] for k in ['writersDrained', 'createdKeysRevoked', 'clientsClosed']) or any(c['kind'] != 'passed' for c in record['checks'].values())):
        raise ValueError('Inconsistent pass')
    if not isinstance(record['measurements'], dict) or len(record['measurements']) > 100 or any(not isinstance(k, str) or len(k) > 64 or (v is not None and (type(v) not in [int, float] or not math.isfinite(v))) for k, v in record['measurements'].items()):
        raise ValueError('Measurements')
    environment = record['environment']
    if not {'node', 'cpu', 'cpus', 'memory', 'kernel', 'image'} <= environment.keys() or environment.keys() - {'node', 'cpu', 'cpus', 'memory', 'kernel', 'image', 'npm', 'docker'} or any(not isinstance(environment[k], str) or len(environment[k]) > 256 for k in ['node', 'cpu', 'kernel', 'image']) or any(type(environment[k]) is not int or not 0 <= environment[k] <= 9007199254740991 for k in ['cpus', 'memory']):
        raise ValueError('Environment')
    for key, limit in [('node', 32), ('image', 80), ('npm', 32), ('docker', 64)]:
        if key in environment and (not isinstance(environment[key], str) or len(environment[key]) > limit):
            raise ValueError('Environment field')
    if 'versions' in record and (set(record['versions']) != {'protocol', 'sdk', 'core'} or any(not isinstance(v, str) or len(v) > 32 for v in record['versions'].values())):
        raise ValueError('Versions')
    return record


def publish(source, destination, run, attempt):
    if not re.fullmatch(r'[0-9]{1,20}', run) or not re.fullmatch(r'[0-9]{1,20}', attempt):
        raise ValueError('Run identity')
    entries = 0
    records = 0
    total = 0
    pending = []
    directories = [Path(source)]
    while directories:
        root = directories.pop()
        with os.scandir(root) as children:
            for entry in children:
                entries += 1
                if entries > 2000:
                    raise ValueError('Artifact entry budget')
                if entry.is_symlink():
                    raise ValueError('Artifact symlink')
                path = Path(entry.path)
                if entry.is_dir(follow_symlinks=False):
                    directories.append(path)
                    continue
                if not entry.is_file(follow_symlinks=False) or not entry.name.endswith('.json') or root.name != 'records':
                    continue
                size = path.stat().st_size
                total += size
                records += 1
                if size > 262144 or total > 67108864 or records > 256:
                    raise ValueError('Record byte budget')
                with path.open('rb') as file:
                    data = file.read(262145)
                if len(data) > 262144:
                    raise ValueError('Record grew')
                record = validate(json.loads(data, parse_constant=lambda _: (_ for _ in ()).throw(ValueError('Nonfinite number'))))
                target = Path(destination, record['scenario'], record['at'].replace(':', '-') + '-' + record['source']['commit'][:12] + '-' + run + '-' + attempt + '.json')
                pending.append((target, data))
    if not pending:
        raise ValueError('No records')
    for target, data in pending:
        if target.parent.is_symlink():
            raise ValueError('History directory symlink')
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open('xb') as file:
            file.write(data)
    return records


if __name__ == '__main__':
    publish(*sys.argv[1:])
