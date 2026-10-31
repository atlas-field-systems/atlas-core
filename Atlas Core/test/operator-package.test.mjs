import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rename, stat, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { defaults } from '../dist/settings.js';
import { mutableRoot } from './paths.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.env.npm_execpath;
const env = {
  ...process.env,
  npm_config_registry: 'http://127.0.0.1:9',
  npm_config_update_notifier: 'false',
};

test(
  'packed operator verifies before offline installation, runs in isolation, and survives replacement and removal',
  { timeout: 240_000 },
  async (t) => {
    assert.ok(npm, 'Run through npm run test:operator-package');
    const base = await mkdtemp(join(mutableRoot, 'packed-'));
    t.diagnostic(`Package and PTY evidence ${base}`);
    const packEnv = {
      ...env,
      ATLAS_OPERATOR_IMAGE: `sha256:${'a'.repeat(64)}`,
      ATLAS_OPERATOR_OUT: base,
    };
    execFileSync(process.execPath, ['scripts/pack-operator.mjs'], { cwd: root, env: packEnv });
    const manifestPath = join(base, 'operator-manifest.json'),
      manifest = JSON.parse(await readFile(manifestPath));
    const tarball = join(base, manifest.operatorPackage.file);
    const verify = () =>
      spawnSync(
        process.execPath,
        [join(base, 'verify-operator-tarball.mjs'), tarball, manifestPath],
        { encoding: 'utf8' },
      );
    assert.equal(verify().status, 0);
    const original = await readFile(tarball),
      tampered = Buffer.from(original);
    tampered[Math.floor(tampered.length / 2)] ^= 1;
    await writeFile(tarball, tampered);
    assert.equal(verify().status, 1, 'A byte change must fail before any npm install');
    await writeFile(tarball, original);
    assert.equal(verify().status, 0);
    const listing = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' });
    assert.ok(!/\.node(?:\n|$)|better-sqlite3|node_modules\//.test(listing));
    const packageJson = JSON.parse(
      execFileSync('tar', ['-xOzf', tarball, 'package/package.json'], { encoding: 'utf8' }),
    );
    assert.deepEqual(packageJson.dependencies, {});
    assert.equal(packageJson.scripts, undefined);
    assert.equal(packageJson.private, true);
    const cache = join(base, 'empty-cache'),
      prefix = join(base, 'installed');
    await mkdir(cache);
    assert.deepEqual(await readdir(cache), []);
    const offlineEnv = { ...env, npm_config_cache: cache, npm_config_prefix: prefix };
    const args = [
      npm,
      'install',
      '--global',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--update-notifier=false',
      '--prefix',
      prefix,
      tarball,
    ];
    const network = join(base, 'offline-network.log');
    execFileSync(
      'strace',
      ['-f', '-e', 'trace=network', '-o', network, process.execPath, ...args],
      { env: offlineEnv },
    );
    const trace = await readFile(network, 'utf8');
    assert.ok(
      !/connect\([^\n]*sa_family=AF_INET|sendto\([^\n]*sa_family=AF_INET/.test(trace),
      'Offline installation must make no network connection',
    );
    const cli = join(prefix, 'bin/atlas-core'),
      installed = join(prefix, 'lib/node_modules', packageJson.name);
    const run = (...args) =>
      spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: base, env: offlineEnv });
    assert.equal(run('version').status, 0);
    assert.match(run('version').stdout, /private qualification fixture/);
    assert.equal(run().status, 0);
    assert.equal(JSON.parse(run('tui').stdout).code, 'terminal_required');
    const tui = (await readdir(join(installed, 'dist'))).find((name) => /^tui-.*\.js$/.test(name));
    assert.ok(tui);
    await rename(join(installed, 'dist', tui), join(installed, 'dist', tui + '.hidden'));
    assert.equal(run('help').status, 0, 'Direct commands must not load a TUI renderer');
    assert.equal(run('version').status, 0);
    await rename(join(installed, 'dist', tui + '.hidden'), join(installed, 'dist', tui));
    const retained = join(base, 'retained');
    await mkdir(join(retained, 'setup'), { recursive: true });
    await writeFile(
      join(retained, 'setup/installation.json'),
      JSON.stringify({
        format: 1,
        installation_id: 'c5d23a5c-d7d6-443a-9b97-ebf37a1a41bc',
        image: `sha256:${'b'.repeat(64)}`,
      }),
    );
    const before = await readFile(join(retained, 'setup/installation.json'));
    const mismatch = run('start', '--installation', retained);
    assert.equal(mismatch.status, 1);
    assert.equal(JSON.parse(mismatch.stdout).code, 'incompatible_image');
    await assert.rejects(stat(join(retained, 'control')), { code: 'ENOENT' });
    assert.deepEqual(await readFile(join(retained, 'setup/installation.json')), before);
    const settingsFixture = join(base, 'settings-fixture.json');
    await writeFile(
      settingsFixture,
      JSON.stringify({
        revision: '0',
        saved: defaults,
        effective: null,
        last_working: null,
        apply_failure: null,
      }),
    );
    const pty = execFileSync(
      'python3',
      [join(root, 'test/operator-pty.py'), process.execPath, cli, join(base, 'pty')],
      {
        encoding: 'utf8',
        env: { ...offlineEnv, ATLAS_PTY_SETTINGS_FIXTURE: settingsFixture },
        timeout: 150_000,
      },
    );
    assert.equal(JSON.parse(pty).pty, 'pass');
    await writeFile(join(base, 'pty-result.json'), pty);
    const edited = join(base, 'pty/settings-absent');
    const json = (...args) => {
      const result = run(...args, '--installation', edited);
      return { status: result.status, ...JSON.parse(result.stdout) };
    };
    assert.match(run('help').stdout, /stop \[--force\]/);
    assert.match(run('help').stdout, /hard-reset --confirm-destructive/);
    assert.match(run('help').stdout, /enrollment inspect \| enrollment revoke/);
    const show = json('settings', 'show');
    assert.equal(show.status, 0);
    assert.equal(show.event, 'command_completed');
    assert.equal(show.data.saved.limits.max_changes, 999);
    assert.equal(show.data.saved.temporary.max_snapshot_bytes, '536870913');
    assert.equal(show.data.saved.diagnosticLevel, 'DEBUG');
    const forced = json('stop', '--force');
    assert.deepEqual([forced.status, forced.data], [0, { stopped: true, writer_exit: 'verified' }]);
    const uuid = 'c5d23a5c-d7d6-443a-9b97-ebf37a1a41bc';
    for (const args of [
      ['hard-reset'],
      ['update'],
      ['enrollment', 'revoke', '--binding', uuid, '--api-key', uuid],
    ]) {
      const refused = json(...args);
      assert.equal(refused.status, 1);
      assert.equal(refused.code, 'destructive_confirmation_required');
    }
    for (const args of [['reset'], ['recover'], ['enrollment', 'inspect']]) {
      const unavailable = json(...args);
      assert.equal(unavailable.status, 1);
      assert.equal(unavailable.event, 'command_failed');
      assert.match(unavailable.code, /^[a-z_]+$/);
    }
    const saveDraft = join(base, 'cli-settings.json');
    await writeFile(saveDraft, JSON.stringify({ ...show.data.saved, maxConnections: 30 }));
    const advanced = json(
      'settings',
      'save',
      '--expected-revision',
      show.data.revision,
      '--file',
      saveDraft,
    );
    assert.equal(advanced.status, 0);
    assert.equal(advanced.data.saved.maxConnections, 30);
    execFileSync(process.execPath, args, { env: offlineEnv });
    assert.deepEqual(await readFile(join(retained, 'setup/installation.json')), before);
    execFileSync(
      process.execPath,
      [
        npm,
        'uninstall',
        '--global',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--update-notifier=false',
        '--prefix',
        prefix,
        packageJson.name,
      ],
      { env: offlineEnv },
    );
    assert.deepEqual(await readFile(join(retained, 'setup/installation.json')), before);
    const bad = join(base, 'bad-package');
    await mkdir(bad);
    await writeFile(
      join(bad, 'package.json'),
      JSON.stringify({
        name: 'atlas-missing-dependency-fixture',
        version: '1.0.0',
        dependencies: { 'atlas-required-uncached-fixture': '1.0.0' },
      }),
    );
    const packed = JSON.parse(
      execFileSync(
        process.execPath,
        [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', base],
        { cwd: bad, env: offlineEnv },
      ),
    );
    const failed = spawnSync(
      process.execPath,
      [
        npm,
        'install',
        '--global',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--update-notifier=false',
        '--prefix',
        join(base, 'bad-prefix'),
        join(base, packed[0].filename),
      ],
      {
        env: { ...offlineEnv, npm_config_cache: join(base, 'another-empty-cache') },
        encoding: 'utf8',
      },
    );
    assert.notEqual(failed.status, 0, 'The qualification must catch a missing runtime dependency');
    await rm(bad, { recursive: true });
  },
);
