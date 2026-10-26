import { spawn } from 'node:child_process';
import { z } from 'zod';
import { join } from 'node:path';
import { processIdentity, exited } from './ownership.js';
import { atomicJson } from './ownership.js';
import type { ContainerWriter } from './installation.js';
import { id } from './exact.js';

const Inspected = z.object({ Id: z.string(), State: z.object({ Running: z.boolean(), Pid: z.number(), ExitCode: z.number() }),
  Config: z.object({ Labels: z.record(z.string(), z.string()).nullable() }), HostConfig: z.object({ LogConfig: z.object({ Type: z.string() }), RestartPolicy: z.object({ Name: z.string() }) }) });
export async function docker(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('sudo', ['-n', 'docker', ...args], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
    const output: Buffer[] = []; let bytes = 0, overflow = false;
    child.stdout.on('data', (chunk: Buffer) => { if ((bytes += chunk.byteLength) <= 65_536) output.push(chunk); else overflow = true; });
    child.stderr.resume();
    child.on('error', () => reject(new Error('docker_unavailable')));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.once('close', code => { if (code !== 0 || overflow) reject(new Error('docker_failed')); else resolve(Buffer.concat(output).toString('utf8').trim()); });
  });
}
export async function inspectContainer(writer: ContainerWriter, installation: string) {
  const result = z.array(Inspected).length(1).parse(JSON.parse(await docker(['inspect', writer.container])))[0];
  if (!result || result.Id !== writer.container || result.Config.Labels?.['atlas.installation'] !== installation || result.Config.Labels?.['atlas.launch'] !== writer.launch || result.HostConfig.LogConfig.Type !== 'none' || result.HostConfig.RestartPolicy.Name !== 'no') throw new Error('writer_identity_mismatch');
  return result;
}
export async function verifyWriterExit(writer: ContainerWriter, installation: string): Promise<void> {
  const state = await inspectContainer(writer, installation);
  if (state.State.Running || writer.host !== null && !await exited(writer.host)) throw new Error('writer_exit_unverified');
}
export async function createContainer(root: string, installation: string, image: string, mode: string, port?: number): Promise<ContainerWriter> {
  const launch = id();
  const args = ['create', '--restart=no', '--log-driver=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--ulimit', 'core=0:0', '--pids-limit=128', '--memory=8g', '--cpus=4', '--network=bridge',
    '--label', `atlas.installation=${installation}`, '--label', `atlas.launch=${launch}`, '--label', `atlas.mode=${mode}`, '--env', `ATLAS_LAUNCH_ID=${launch}`, '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    '--mount', `type=bind,source=${join(root, 'data')},target=/atlas/data${mode === 'inspect-marker' ? ',readonly' : ''}`, '--mount', `type=bind,source=${join(root, 'setup')},target=/atlas/setup,readonly`,
    '--mount', `type=bind,source=${join(root, 'control')},target=/atlas/control${mode === 'inspect-marker' ? ',readonly' : ''}`, '--mount', `type=bind,source=${join(root, 'recovery')},target=/atlas/recovery,readonly`, '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m'];
  if (port !== undefined) args.push('--publish', `${port}:${port}`);
  if (mode !== 'serve') args.push('--interactive');
  args.push(image, 'node', '--disable-warning=ExperimentalWarning', '--disable-warning=DeprecationWarning', 'dist/runtime.js', mode, '/atlas');
  const container = await docker(args);
  if (!/^[0-9a-f]{64}$/.test(container)) throw new Error('docker_identity_unavailable');
  return { container, launch, kind: mode === 'serve' ? 'service' : 'oneshot', host: null };
}
export async function startContainer(root: string, writer: ContainerWriter, installation: string, attach = false, input?: string): Promise<string> {
  await atomicJson(join(root, 'control', 'writer.json'), writer);
  const result = await docker(attach ? ['start', '--attach', '--interactive', writer.container] : ['start', writer.container], input);
  const state = await inspectContainer(writer, installation);
  if (state.State.Running) {
    writer.host = await processIdentity(state.State.Pid);
    await atomicJson(join(root, 'control', 'writer.json'), writer);
  }
  return result;
}
