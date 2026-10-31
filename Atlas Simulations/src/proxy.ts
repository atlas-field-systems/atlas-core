import { exchanges } from '@atlas/protocol';
import { readFile } from 'node:fs/promises';
import { createServer, request } from 'node:https';
import type { Duplex } from 'node:stream';
import { id } from './sdk.js';
export type ProxyEvent = {
  connection: string;
  path: string;
  status: number;
  bytes: number;
  action: 'dropped' | 'delayed' | 'altered' | 'closed';
  upstreamDigest: string;
  requestId?: string;
  commitCursor?: string | null;
};
export type ProxyRule = {
  path: string;
  kind: 'drop' | 'delay' | 'alter' | 'version' | 'unavailable';
  delayMs?: number;
  requestId?: string;
  fired: (event: ProxyEvent) => void;
};
export class Proxy {
  private readonly sockets = new Map<Duplex, string>();
  private readonly upstreams = new Set<Duplex>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly rules: ProxyRule[] = [];
  private reserved = 0;
  private server: ReturnType<typeof createServer> | undefined;
  baseUrl = '';
  upstreamPauses = 0;
  upstreamClosures = 0;
  requests = 0;
  readonly requestCounts = new Map<string, number>();
  private readonly changes = new Set<Duplex>();
  constructor(readonly upstream: string) {}
  arm(rule: ProxyRule): void {
    if (this.rules.length + this.timers.size >= 16) throw new Error('Proxy rule capacity');
    this.rules.push(rule);
  }
  async start(): Promise<void> {
    const cert = process.env.NODE_EXTRA_CA_CERTS,
      key = process.env.ATLAS_SIM_TLS_KEY;
    if (!cert || !key) throw new Error('Proxy TLS files missing');
    const server = createServer(
      { cert: await readFile(cert), key: await readFile(key), maxHeaderSize: 16384 },
      (incoming, outgoing) => {
        if (this.sockets.size > 64) {
          outgoing.destroy();
          return;
        }
        this.requests++;
        const path = incoming.url ?? '/';
        if (!this.requestCounts.has(path) && this.requestCounts.size >= 128) {
          outgoing.destroy();
          return;
        }
        this.requestCounts.set(path, (this.requestCounts.get(path) ?? 0) + 1);
        let requestIdentity: string | undefined;
        if (this.rules.some((rule) => rule.path === path && rule.requestId !== undefined)) {
          const chunks: Buffer[] = [];
          let held = 0;
          const releaseRequest = () => {
            this.reserved -= held;
            held = 0;
            chunks.length = 0;
          };
          incoming.on('data', (chunk: Buffer) => {
            if (held + chunk.length > 1048576 || this.reserved + chunk.length > 16777216) {
              incoming.destroy(new Error('Proxy request capture budget'));
              return;
            }
            held += chunk.length;
            this.reserved += chunk.length;
            chunks.push(chunk);
          });
          incoming.once('error', releaseRequest);
          incoming.once('aborted', releaseRequest);
          incoming.once('end', () => {
            const copied = held;
            if (this.reserved + copied > 16777216) {
              releaseRequest();
              incoming.destroy(new Error('Proxy request copy budget'));
              return;
            }
            this.reserved += copied;
            try {
              const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (
                typeof value === 'object' &&
                value !== null &&
                'request_id' in value &&
                typeof value.request_id === 'string'
              )
                requestIdentity = value.request_id;
            } catch {
              requestIdentity = undefined;
            } finally {
              this.reserved -= copied;
              releaseRequest();
            }
          });
        }
        const upstream = request(
          new URL(path, this.upstream),
          { method: incoming.method ?? 'POST', headers: incoming.headers, timeout: 10000 },
          (response) => {
            const ruleIndex = this.rules.findIndex(
              (r) =>
                r.path === path && (r.requestId === undefined || r.requestId === requestIdentity),
            );
            if (ruleIndex < 0) {
              outgoing.writeHead(response.statusCode ?? 502, response.headers);
              response.pipe(outgoing);
              return;
            }
            const rule = this.rules.splice(ruleIndex, 1)[0];
            if (!rule) {
              response.destroy();
              return;
            }
            const chunks: Buffer[] = [];
            let length = 0,
              allocated = 0;
            response.on('data', (chunk: Buffer) => {
              if (length + chunk.length > 4194304 || this.reserved + chunk.length > 16777216) {
                response.destroy(new Error('Proxy buffer capacity'));
                return;
              }
              length += chunk.length;
              allocated += chunk.length;
              this.reserved += chunk.length;
              chunks.push(chunk);
            });
            response.once('error', () => {
              this.reserved -= allocated;
              allocated = 0;
              outgoing.destroy();
            });
            response.once('end', () => {
              if (this.reserved + length > 16777216) {
                outgoing.destroy();
                this.reserved -= allocated;
                allocated = 0;
                return;
              }
              this.reserved += length;
              const body = Buffer.concat(chunks);
              chunks.length = 0;
              let retained = length;
              const release = () => {
                this.reserved -= retained;
                retained = 0;
              };
              outgoing.once('close', release);
              this.reserved -= allocated;
              allocated = 0;
              const status = response.statusCode ?? 502;
              const connection = this.sockets.get(incoming.socket) ?? 'ended';
              import('node:crypto')
                .then(({ createHash }) => {
                  const value: unknown = JSON.parse(body.toString('utf8'));
                  const commit =
                    typeof value === 'object' &&
                    value !== null &&
                    'commit_cursor' in value &&
                    (value.commit_cursor === null || typeof value.commit_cursor === 'string')
                      ? { commitCursor: value.commit_cursor }
                      : {};
                  const event: ProxyEvent = {
                    ...commit,
                    connection,
                    ...(requestIdentity === undefined ? {} : { requestId: requestIdentity }),
                    path,
                    status,
                    bytes: length,
                    action:
                      rule.kind === 'drop'
                        ? 'dropped'
                        : rule.kind === 'delay'
                          ? 'delayed'
                          : 'altered',
                    upstreamDigest: createHash('sha256').update(body).digest('hex'),
                  };
                  if (status === 200) {
                    const binding = Object.values(exchanges).find((entry) => entry.path === path);
                    if (!binding?.success.safeParse(JSON.parse(body.toString('utf8'))).success) {
                      outgoing.destroy();
                      return;
                    }
                  }
                  rule.fired(event);
                  if (rule.kind === 'drop') {
                    outgoing.destroy();
                    return;
                  }
                  const send = () => {
                    const headers = { ...response.headers };
                    delete headers['content-length'];
                    if (rule.kind === 'version') headers['atlas-protocol-version'] = '9.9.9';
                    if (rule.kind === 'unavailable') {
                      delete headers['atlas-dataset-id'];
                      delete headers['atlas-protocol-version'];
                      outgoing.writeHead(503, headers);
                      outgoing.end(release);
                      return;
                    }
                    outgoing.writeHead(status, headers);
                    const rewritten =
                      rule.kind === 'version'
                        ? Buffer.from(
                            JSON.stringify({
                              ...JSON.parse(body.toString('utf8')),
                              data: {
                                ...JSON.parse(body.toString('utf8')).data,
                                protocol_version: '9.9.9',
                              },
                            }),
                          )
                        : body;
                    outgoing.end(
                      rule.kind === 'alter' ? Buffer.from('{"invalid":true}') : rewritten,
                      release,
                    );
                  };
                  if (rule.kind === 'delay') {
                    const timer = setTimeout(() => {
                      this.timers.delete(timer);
                      send();
                    }, rule.delayMs ?? 5000);
                    this.timers.add(timer);
                    outgoing.once('close', () => {
                      clearTimeout(timer);
                      this.timers.delete(timer);
                    });
                  } else send();
                })
                .catch(() => outgoing.destroy());
            });
          },
        );
        upstream.once('socket', (socket) => {
          if (this.upstreams.has(socket)) return;
          this.upstreams.add(socket);
          socket.once('close', () => this.upstreams.delete(socket));
        });
        upstream.once('timeout', () => upstream.destroy());
        upstream.once('error', () => outgoing.destroy());
        incoming.once('aborted', () => upstream.destroy());
        incoming.pipe(upstream);
      },
    );
    server.on('secureConnection', (socket) => {
      if (this.sockets.size >= 64) {
        socket.destroy();
        return;
      }
      this.sockets.set(socket, id());
      socket.once('close', () => this.sockets.delete(socket));
    });
    server.on('upgrade', (incoming, socket, head) => {
      const upstream = request(new URL(incoming.url ?? '/', this.upstream), {
        method: 'GET',
        headers: incoming.headers,
      });
      upstream.once('upgrade', (response, peer, upstreamHead) => {
        this.upstreams.add(peer);
        this.changes.add(peer);
        peer.once('end', () => {
          this.upstreamClosures++;
        });
        peer.once('close', () => this.changes.delete(peer));
        peer.once('close', () => this.upstreams.delete(peer));
        socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
        for (const [name, value] of Object.entries(response.headers))
          if (value !== undefined)
            socket.write(`${name}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`);
        socket.write('\r\n');
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) peer.write(head);
        peer.on('pause', () => {
          this.upstreamPauses++;
        });
        peer.pipe(socket);
        socket.pipe(peer);
        socket.once('close', () => peer.destroy());
        peer.once('end', () => socket.end());
        peer.once('close', () => {
          if (!socket.writableEnded) socket.end();
        });
      });
      upstream.once('response', (response) => {
        response.resume();
        socket.destroy();
      });
      upstream.once('error', () => socket.destroy());
      upstream.end();
    });
    await new Promise<void>((ok, bad) => {
      server.once('error', bad);
      server.listen(0, '127.0.0.1', ok);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Proxy address');
    this.baseUrl = `https://localhost:${address.port}`;
    this.server = server;
  }
  pauseChanges(): () => void {
    const peers = [...this.changes];
    for (const peer of peers) peer.pause();
    return () => {
      for (const peer of peers) peer.resume();
    };
  }
  closeConnection(identity: string): ProxyEvent | undefined {
    for (const [socket, connection] of this.sockets)
      if (connection === identity && !socket.destroyed) {
        socket.destroy();
        return { connection, path: '*', status: 0, bytes: 0, action: 'closed', upstreamDigest: '' };
      }
    return undefined;
  }
  closeConnections(): ProxyEvent[] {
    const result: ProxyEvent[] = [];
    for (const [socket, connection] of this.sockets) {
      result.push({
        connection,
        path: '*',
        status: 0,
        bytes: 0,
        action: 'closed',
        upstreamDigest: '',
      });
      socket.destroy();
    }
    for (const socket of this.upstreams) socket.destroy();
    return result;
  }
  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.closeConnections();
    if (this.server)
      await new Promise<void>((ok, bad) => this.server!.close((e) => (e ? bad(e) : ok())));
  }
}
