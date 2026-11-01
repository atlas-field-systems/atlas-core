import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { command } from './process.js';
import { id } from './sdk.js';
const cli = fileURLToPath(new URL('../../Atlas Core/dist/cli.js', import.meta.url));
const workspace = fileURLToPath(new URL('../../', import.meta.url));
const reply = z.object({ ok: z.literal(true), data: z.unknown() });
const container = z.object({
  Id: z.string().regex(/^[a-f0-9]{64}$/),
  State: z.object({ Running: z.boolean() }),
  Config: z.object({ Labels: z.record(z.string(), z.string()) }),
});
export async function externalRoot(): Promise<string> {
  const path = process.env.ATLAS_TEST_ROOT;
  if (!path || !isAbsolute(path)) throw new Error('Set absolute external ATLAS_TEST_ROOT');
  await mkdir(path, { recursive: true });
  const rel = relative(await realpath(workspace), await realpath(path));
  if (!(rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)))
    throw new Error('ATLAS_TEST_ROOT must be outside workspace');
  return path;
}
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok, bad) => {
    server.once('error', bad);
    server.listen(0, '127.0.0.1', ok);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Port allocation failed');
  await new Promise<void>((ok, bad) => server.close((e) => (e ? bad(e) : ok())));
  return address.port;
}
export class Core {
  readonly installation: string;
  readonly credential = {
    api_key_id: id(),
    request_id: id(),
    secret: randomBytes(32).toString('base64url'),
  };
  baseUrl = '';
  activeSettingsHash: string | undefined;
  private pendingSettingsHash: string | undefined;
  readonly appliedSettingsHashes: string[] = [];
  setupAttempted = false;
  containerId: string | undefined;
  private installationId: string | undefined;
  private launch: string | undefined;
  constructor(readonly directory: string) {
    this.installation = join(directory, 'installation');
  }
  static async allocate(): Promise<Core> {
    return new Core(await mkdtemp(join(await externalRoot(), 'run-')));
  }
  async cli(args: readonly string[]): Promise<unknown> {
    const output = await command(process.execPath, [
      cli,
      ...args,
      '--installation',
      this.installation,
    ]);
    const data = reply.parse(JSON.parse(output)).data;
    if (args[0] === 'settings' && args[1] === 'save') {
      const path = args[args.indexOf('--file') + 1];
      if (!path) throw new Error('Saved Settings file absent');
      this.pendingSettingsHash = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
    }
    if (args[0] === 'settings' && args[1] === 'apply' && this.pendingSettingsHash) {
      if (this.appliedSettingsHashes.length >= 100)
        throw new Error('Applied Settings record budget');
      this.activeSettingsHash = this.pendingSettingsHash;
      this.appliedSettingsHashes.push(this.activeSettingsHash);
    }
    return data;
  }
  async setup(): Promise<void> {
    const image = (
      await readFile(new URL('../../Atlas Core/artifacts/image-id', import.meta.url), 'utf8')
    ).trim();
    z.string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .parse(image);
    await command('docker', ['image', 'inspect', image]);
    const ca = process.env.NODE_EXTRA_CA_CERTS;
    const key = process.env.ATLAS_SIM_TLS_KEY;
    if (!ca || !key)
      throw new Error('TLS trust and ATLAS_SIM_TLS_KEY must be installed before Node starts');
    const candidate = z
      .record(z.string(), z.json())
      .parse(JSON.parse(await readFile(new URL('../settings/eval.json', import.meta.url), 'utf8')));
    const listenPort = await port();
    candidate.port = listenPort;
    this.baseUrl = `https://localhost:${listenPort}`;
    const settings = join(this.directory, 'settings.json'),
      credential = join(this.directory, 'credential.json');
    const settingsBytes = JSON.stringify(candidate);
    await writeFile(settings, settingsBytes, { mode: 0o600 });
    this.activeSettingsHash = createHash('sha256').update(settingsBytes).digest('hex');
    this.appliedSettingsHashes.push(this.activeSettingsHash);
    await writeFile(credential, JSON.stringify(this.credential), { mode: 0o600 });
    this.setupAttempted = true;
    await this.cli([
      'setup',
      '--image',
      image,
      '--certificate',
      resolve(ca),
      '--key',
      resolve(key),
      '--credential-file',
      credential,
      '--settings',
      settings,
    ]);
    await this.cli(['start']);
    await this.findContainer();
  }
  async findContainer(): Promise<string> {
    const selectors = this.installationId
      ? ['--filter', `label=atlas.installation=${this.installationId}`]
      : ['--filter', `volume=${join(this.installation, 'data')}`];
    const ids = (
      await command('docker', [
        'ps',
        '--no-trunc',
        ...selectors,
        '--filter',
        'label=atlas.mode=serve',
        '--format',
        '{{.ID}}',
      ])
    )
      .split('\n')
      .filter(Boolean);
    if (ids.length !== 1 || !ids[0]) throw new Error('Expected one owned service container');
    const result = z
      .array(container)
      .length(1)
      .parse(JSON.parse(await command('docker', ['inspect', ids[0]])))[0];
    if (
      !result ||
      result.Id !== ids[0] ||
      !result.Config.Labels['atlas.installation'] ||
      (this.installationId !== undefined &&
        result.Config.Labels['atlas.installation'] !== this.installationId) ||
      !result.Config.Labels['atlas.launch']
    )
      throw new Error('Container identity mismatch');
    this.installationId = result.Config.Labels['atlas.installation'];
    this.containerId = result.Id;
    this.launch = result.Config.Labels['atlas.launch'];
    return result.Id;
  }
  async kill(): Promise<string> {
    const current = await this.findContainer();
    await command('docker', ['kill', '--signal', 'KILL', current]);
    return current;
  }
  async stop(): Promise<void> {
    if (!this.setupAttempted) return;
    await this.cli(['stop', '--force']);
    if (this.containerId) {
      const result = z
        .array(container)
        .length(1)
        .parse(JSON.parse(await command('docker', ['inspect', this.containerId])))[0];
      if (
        !result ||
        result.State.Running ||
        result.Config.Labels['atlas.installation'] !== this.installationId ||
        result.Config.Labels['atlas.launch'] !== this.launch
      )
        throw new Error('Core exit unverified');
    }
  }
}
