import { spawn } from 'node:child_process';
export function command(
  program: string,
  args: readonly string[],
  timeoutMs = 120000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let bytes = 0,
      failure: Error | undefined;
    const stop = (reason: Error) => {
      failure ??= reason;
      child.kill('SIGTERM');
    };
    const timer = setTimeout(() => stop(new Error(`Command deadline ${program}`)), timeoutMs);
    const force = setTimeout(() => child.kill('SIGKILL'), timeoutMs + 5000);
    const collect = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1048576) stop(new Error(`Command output limit ${program}`));
      else chunks.push(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => {
      failure ??= error;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      clearTimeout(force);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new Error(
            `Command ${program} exited ${code}: ${Buffer.concat(chunks).toString('utf8').slice(-8192)}`,
          ),
        );
      else resolve(Buffer.concat(chunks).toString('utf8').trim());
    });
  });
}
