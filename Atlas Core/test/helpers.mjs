import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { randomBytes, randomUUID } from 'node:crypto';
import { defaults } from '../dist/settings.js';
import { createCore } from '../dist/server.js';
import { exchanges } from '@atlas/protocol';

export const uuid = () => randomUUID();
export const secret = () => randomBytes(32).toString('base64url');
export const root = fileURLToPath(new URL('../', import.meta.url));
export async function fixture(t, overrides = {}) {
  await mkdir(join(root, 'artifacts'), { recursive: true });
  const directory = await mkdtemp(join(root, 'artifacts', 'installation-'));
  const certificate = join(directory, 'tls.pem'), key = join(directory, 'tls.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', certificate], { cwd: root, stdio: 'ignore' });
  const settings = { ...defaults, host: '127.0.0.1', port: 0, freeDiskBytes: 0, ...overrides };
  const apiKey = secret();
  let core = await createCore({ directory, certificate, key, settings });
  await core.rpc.call('provision', { api_key_id: uuid(), request_id: uuid(), secret: apiKey }, 1024, true);
  let address = await core.listen();
  const ca = await readFile(certificate);
  const seen = new Set();
  async function http(method, path, data, additional = {}) {
    const body = data === undefined ? undefined : Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
    return new Promise((resolve, reject) => {
      const req = httpsRequest(new URL(path, address), { method, ca, headers: Object.fromEntries(Object.entries({
        Authorization: `Bearer ${apiKey}`, 'Atlas-Dataset-ID': core.dataset, 'Atlas-Protocol-Version': '0.3.0',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': body.byteLength }), ...additional,
      }).filter(([, value]) => value !== undefined && value !== null)) }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => { const bytes = Buffer.concat(chunks); let json; try { json = JSON.parse(bytes.toString()); } catch {} resolve({ status: res.statusCode, headers: res.headers, bytes, json }); });
      });
      req.on('error', reject); req.end(body);
    });
  }
  async function call(name, data = {}, additional = {}) {
    const def = exchanges[name];
    const path = name === 'ReadObjectContent' ? `/objects/${data.object_id}/content?disposition=${data.disposition}` : def.path;
    const result = await http(def.method, path, def.method === 'GET' ? undefined : data, name === 'GetReference' ? { Accept: 'application/vnd.oai.openapi+json', ...additional } : additional);
    if (result.status === 200 || name === 'GetReadiness' && result.status === 503 && result.json?.data) seen.add(name);
    return result;
  }
  t.after(async () => { await core.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, certificate, key, settings, ca, apiKey, http, call, seen,
    get core() { return core; }, get address() { return address; },
    async restart() { await core.close(); core = await createCore({ directory, certificate, key, settings }); address = await core.listen(); },
    async upload(descriptor, bytes, reverse = false, extra = {}) {
      const boundary = 'atlas-test-boundary';
      const descriptorPart = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="descriptor"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(descriptor)}\r\n`);
      const filePart = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="payload.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, Buffer.from('\r\n')]);
      const body = Buffer.concat([...(reverse ? [filePart, descriptorPart] : [descriptorPart, filePart]), Buffer.from(`--${boundary}--\r\n`)]);
      const result = await http('POST', '/objects', body, { 'Content-Type': `multipart/form-data; boundary=${boundary}`, ...extra });
      if (result.status === 200) seen.add('UploadObject');
      return result;
    } };
}
export function report(dataset, entity, origin, sequence, sections, mode = 'current') {
  return { dataset_id: dataset, entity_id: entity, origin, report_id: uuid(), sequence: String(sequence), generated_at: new Date().toISOString(), mode, sections };
}
export function telemetry(origin, latitude, at = '2026-10-21T12:00:01Z', reading = uuid()) {
  return { state: 'value', classification: 'dated_measurement', observed_at: at, value: { position: { latitude, longitude: -1 }, altitude: null, ground_speed: 0 },
    constituents: { position: { origin, reading_id: reading }, altitude: { origin, reading_id: uuid() }, ground_speed: { origin, reading_id: uuid() } } };
}
export function registration(alias) {
  return { asset_id: uuid(), registration_id: uuid(), request_id: uuid(), process_generation: uuid(), api_key_id: uuid(), secret: secret(),
    ...(alias === undefined ? {} : { alias }), capabilities: { commands: [{ command: 'move_to', scheduling: ['queued'] }, { command: 'pause', scheduling: ['immediate'] }, { command: 'resume', scheduling: ['immediate'] }] } };
}
